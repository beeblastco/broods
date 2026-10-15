import type { CliManifest } from "../../../packages/broods/src/contracts.ts";
import { BroodsSyncClient } from "../../../packages/broods/src/sync.ts";
import { assertStep, convexResult, type VerifyContext } from "../harness.ts";

/**
 * An automated deploy chooses where Production runs: the first manifest PUT
 * pins the region it names, a later one naming another region is refused
 * with 409 and leaves it, an unknown one is a 400, and one naming none keeps
 * it. Config only.
 */
export async function productionRegion(context: VerifyContext): Promise<void> {
  const sync = new BroodsSyncClient({
    baseUrl: context.edgeUrl,
    token: context.accountSecret,
  });
  const project = `region-${context.runId}`;
  const manifest = (region?: CliManifest["region"]): CliManifest => ({
    version: 1,
    project: project,
    stage: "production",
    ...(region ? { region: region } : {}),
    resources: [
      {
        kind: "agent",
        name: "helper",
        config: {
          model: context.model.model,
          agent: { system: "You help." },
        },
      },
    ],
  });

  await context.measure("deploy production to eu-west-1", () =>
    sync.putManifest(manifest("eu-west-1"), true),
  );
  const pinned = await productionRegionOf(context, project);
  assertStep(
    "the first deploy pins Production to the region it names",
    pinned === "eu-west-1",
    `region ${String(pinned)}`,
  );

  // A refused deploy's error text, or "deployed".
  const outcome = (body: CliManifest): Promise<string> =>
    sync.putManifest(body, true).then(
      (): string => "deployed",
      (error: unknown): string => String(error),
    );

  const moved = await outcome(manifest("us-east-1"));
  assertStep(
    "a later deploy cannot move Production to another region",
    moved.includes("409") && moved.includes("already runs in eu-west-1"),
    moved.slice(0, 200),
  );

  const unknown = await outcome({
    ...manifest(),
    region: "mars-1" as CliManifest["region"],
  });
  assertStep(
    "an unknown region is a 400, not a server error",
    unknown.includes("400") && unknown.includes(`Unknown region "mars-1"`),
    unknown.slice(0, 200),
  );

  await sync.putManifest(manifest(), true);
  const kept = await productionRegionOf(context, project);
  assertStep(
    "a deploy naming no region keeps the pinned one",
    kept === "eu-west-1",
    `region ${String(kept)}`,
  );
}

async function productionRegionOf(
  context: VerifyContext,
  project: string,
): Promise<string | undefined> {
  const { accountId } = await context.account.getAccount();
  const stages = convexResult(
    context,
    "cli/stages:listByAccount",
    { accountId: accountId, project: project },
    "list the project's stages",
  ) as Array<{ kind: string; deploymentRegion?: string }>;

  return stages.find((stage) => stage.kind === "production")?.deploymentRegion;
}
