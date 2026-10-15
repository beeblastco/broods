import type { CliManifest } from "../../../packages/broods/src/contracts.ts";
import { BroodsSyncClient } from "../../../packages/broods/src/sync.ts";
import { assertStep, convexResult, type VerifyContext } from "../harness.ts";

type StageScope = { projectId: string; stageId: string };

/**
 * A snapshot is locked to the stage it was taken on. Two stages of one project
 * each hold a sandbox; a production snapshot is registered the way core's
 * snapshot verb records one. A dev-pinned role session, the account key and a
 * CLI deploy are all refused when they point the dev sandbox at it, and the
 * dev sandbox still pins a dev snapshot. Config only, so it needs no model key
 * and no provider account.
 */
export async function snapshotStage(context: VerifyContext): Promise<void> {
  const sync = new BroodsSyncClient({
    baseUrl: context.edgeUrl,
    token: context.accountSecret,
  });
  const project = `snapshot-stage-${context.runId}`;
  const manifest = (stage: string, snapshot?: string): CliManifest => ({
    version: 1,
    project: project,
    stage: stage,
    resources: [
      {
        kind: "sandbox",
        name: "box",
        config: {
          provider: "e2b",
          network: { mode: "allow-all" },
          ...(snapshot ? { snapshot: snapshot } : {}),
        },
      },
    ],
  });
  const dev = await context.measure("deploy development", () =>
    sync.putManifest(manifest("development"), true),
  );
  const prod = await context.measure("deploy production", () =>
    sync.putManifest(manifest("production"), true),
  );
  const devBox = dev.ids.sandboxes.box;
  const prodBox = prod.ids.sandboxes.box;
  assertStep(
    "each stage has its own sandbox",
    Boolean(devBox && prodBox && devBox !== prodBox),
    JSON.stringify({ devBox: devBox, prodBox: prodBox }),
  );
  const { accountId } = await context.account.getAccount();
  const scopeOf = (sandboxId: string): StageScope =>
    convexResult(
      context,
      "account/roles:resourceScope",
      { accountId: accountId, type: "sandboxes", id: sandboxId },
      "read the sandbox's stage",
    ) as StageScope;
  const devScope = scopeOf(devBox!);
  const prodScope = scopeOf(prodBox!);
  const register = (scope: StageScope, image: string): void => {
    convexResult(
      context,
      "sandbox/snapshots:upsert",
      {
        accountId: accountId,
        scope: scope,
        name: "disk",
        provider: "e2b",
        baseImage: "e2b",
        externalImageId: image,
      },
      `register a snapshot taken on ${scope.stageId}`,
    );
  };
  const prodImage = `snap-prod-${context.runId}`;
  const devImage = `snap-dev-${context.runId}`;
  register(prodScope, prodImage);
  register(devScope, devImage);

  const send = async (
    method: string,
    path: string,
    token: string,
    body?: Record<string, unknown>,
  ): Promise<Response> =>
    await fetch(`${context.edgeUrl}${path}`, {
      method: method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
  const created = await send("POST", "/v1/roles", context.accountSecret, {
    name: `snapshot-dev-${context.runId}`,
    policy: {
      version: 1,
      rules: [
        {
          id: "sandboxes",
          effect: "allow",
          actions: ["sandboxes:read", "sandboxes:write"],
        },
      ],
    },
    projectId: devScope.projectId,
    stageId: devScope.stageId,
  });
  const { roleId } = (await created.json()) as { roleId: string };
  try {
    const assumed = await send(
      "POST",
      "/v1/account/assume-role",
      context.accountSecret,
      { roleId: roleId },
    );
    const { token } = (await assumed.json()) as { token: string };
    const pin = (bearer: string, image: string): Promise<Response> =>
      send("PATCH", `/v1/sandboxes/${devBox}`, bearer, {
        config: { snapshot: image },
      });

    const pinned = await context.measure(
      "pin a production snapshot from a dev role session",
      () => pin(token, prodImage),
    );
    const refusal = await pinned.text();
    assertStep(
      "a dev-pinned role cannot point its sandbox at a production snapshot",
      pinned.status === 400 && refusal.includes("another stage"),
      `${pinned.status} ${refusal.slice(0, 200)}`,
    );
    const asAccount = await pin(context.accountSecret, prodImage);
    assertStep(
      "the account key cannot cross stages either",
      asAccount.status === 400,
      `${asAccount.status} ${(await asAccount.text()).slice(0, 200)}`,
    );
    const deployed = await sync
      .putManifest(manifest("development", prodImage), true)
      .then(
        (): string => "deployed",
        (error: unknown): string => String(error),
      );
    assertStep(
      "a deploy cannot point the dev sandbox at a production snapshot",
      deployed.includes("another stage"),
      deployed.slice(0, 200),
    );
    const own = await pin(token, devImage);
    assertStep(
      "the dev sandbox still pins its own stage's snapshot",
      own.status === 200,
      `${own.status} ${(await own.text()).slice(0, 200)}`,
    );
  } finally {
    await send("DELETE", `/v1/roles/${roleId}`, context.accountSecret);
  }
}
