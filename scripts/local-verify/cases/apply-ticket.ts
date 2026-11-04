import type { Doc } from "../../../packages/convex/_generated/dataModel.ts";
import { BroodsSyncClient } from "../../../packages/broods/src/sync.ts";
import { sealApplyTicket } from "../../../packages/convex/model/applyTicket.ts";
import { OK_AGENT, assertStep, type VerifyContext } from "../harness.ts";

// The compile sandbox's credential: it deploys one stage as the member who applied, nothing else.
export async function applyTicket(context: VerifyContext): Promise<void> {
  const project = `apply-${context.runId}`;
  const manifest = (
    system: string,
  ): Parameters<BroodsSyncClient["putManifest"]>[0] => ({
    version: 1,
    project: project,
    stage: "development",
    resources: [
      {
        kind: "agent",
        name: "coder",
        config: { ...context.model, agent: { ...OK_AGENT, system: system } },
      },
    ],
  });
  const owner = new BroodsSyncClient({
    baseUrl: context.edgeUrl,
    token: context.accountSecret,
  });
  const first = await owner.putManifest(manifest("v1"), true);
  const rows = <T>(table: string): T[] => {
    const cli = context.convex([
      "data",
      table,
      "--format",
      "json",
      "--limit",
      "1000",
    ]);

    return JSON.parse(cli.output.slice(cli.output.indexOf("["))) as T[];
  };
  const projectDoc = rows<Doc<"projects">>("projects").find(
    (row): boolean => row.slug === first.deployment?.projectSlug,
  );
  const stageDoc = rows<Doc<"stages">>("stages").find(
    (row): boolean =>
      row.projectId === projectDoc?._id &&
      row.name.toLowerCase() === "development",
  );
  const ticket = (authId: string): Promise<string> =>
    sealApplyTicket(
      {
        accountId: first.deployment?.accountId ?? "",
        projectId: projectDoc?._id ?? "",
        stageId: stageDoc?._id ?? "",
        authId: authId,
      },
      context.stageTicketSecret,
    );
  const as = async (token: string): Promise<BroodsSyncClient> =>
    new BroodsSyncClient({ baseUrl: context.edgeUrl, token: token });

  const member = await as(await ticket(`local-${context.runId}`));
  const applied = await context.measure("deploy with an apply ticket", () =>
    member.putManifest(manifest("v2"), true),
  );
  const keyRead = await member.getRuntimeKey(project, "development").then(
    (): string => "read",
    (error: unknown): string => String(error),
  );
  const stranger = await (
    await as(await ticket("local-stranger"))
  )
    .putManifest(manifest("v3"), true)
    .then(
      (): string => "synced",
      (error: unknown): string => String(error),
    );
  const after = await owner.getManifest(project, "development");
  assertStep(
    "an apply ticket deploys its stage as its member and opens nothing else",
    applied.manifestHash !== first.manifestHash &&
      keyRead.includes("401") &&
      stranger.includes("401") &&
      after?.manifestHash === applied.manifestHash,
    JSON.stringify({ keyRead: keyRead, stranger: stranger }),
  );
  const proxied = await fetch(`${context.edgeUrl}/v1/apply-runs`, {
    method: "POST",
    headers: { Authorization: `Bearer ${context.serviceSecret}` },
    body: "{}",
  });
  await proxied.body?.cancel();
  assertStep(
    "the apply run route refuses the service token through the edge",
    proxied.status === 401,
    `status ${proxied.status}`,
  );
}
