import type { CliManifest } from "../../../packages/broods/src/contracts.ts";
import { BroodsSyncClient } from "../../../packages/broods/src/sync.ts";
import { sha256Hex } from "../../../packages/convex/model/accountSecrets.ts";
import { assertStep, type VerifyContext } from "../harness.ts";

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

  const moved = await sync.putManifest(manifest("us-east-1"), true).then(
    (): string => "deployed",
    (error: unknown): string => String(error),
  );
  assertStep(
    "a later deploy cannot move Production to another region",
    moved.includes("409") && moved.includes("already runs in eu-west-1"),
    moved.slice(0, 200),
  );

  const unknown = await sync
    .putManifest(
      { ...manifest(), region: "mars-1" as CliManifest["region"] },
      true,
    )
    .then(
      (): string => "deployed",
      (error: unknown): string => String(error),
    );
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
  const account = runConvex(context, "account/accounts:getBySecretHash", {
    secretHash: await sha256Hex(context.accountSecret),
  }) as { _id: string };
  const stages = runConvex(context, "cli/stages:listByAccount", {
    accountId: account._id,
    project: project,
  }) as Array<{ kind: string; deploymentRegion?: string }>;

  return stages.find((stage) => stage.kind === "production")?.deploymentRegion;
}

/** Runs an internal Convex function with the stack's admin key and parses its result. */
function runConvex(
  context: VerifyContext,
  fn: string,
  args: Record<string, unknown>,
): unknown {
  const cli = context.convex(["run", fn, JSON.stringify(args)]);
  assertStep(`convex run ${fn}`, cli.ok, cli.output.slice(-300));
  const start = cli.output.search(/^[[{"\dn]/m);

  return start < 0 ? null : JSON.parse(cli.output.slice(start));
}
