import type { CliManifest } from "../../../packages/broods/src/contracts.ts";
import { BroodsSyncClient } from "../../../packages/broods/src/sync.ts";
import type { StageSource } from "../../../packages/convex/model/stageSource.ts";
import { assertStep, type VerifyContext } from "../harness.ts";

export async function stageSource(context: VerifyContext): Promise<void> {
  const client = new BroodsSyncClient({
    baseUrl: context.edgeUrl,
    token: context.accountSecret,
  });
  const project = `source-${context.runId}`;
  const manifest = (system: string): CliManifest => ({
    version: 1,
    project: project,
    stage: "development",
    resources: [
      {
        kind: "agent",
        name: "coder",
        config: { model: context.model.model, agent: { system: system } },
      },
    ],
  });
  const source = (body: string): StageSource => ({
    files: [
      { path: "package.json", content: '{"name":"source"}\n' },
      { path: "broods/index.ts", content: body },
    ],
  });
  const sync = (
    system: string,
    files: StageSource,
  ): ReturnType<typeof client.putManifest> =>
    context.measure("sync with source", () =>
      client.putManifest(manifest(system), true, false, undefined, files),
    );

  const first = await sync("v1", source("export const a = 1;\n"));
  const read = await client.getManifest(project, "development");
  assertStep(
    "a sync stores the source and answers the manifest hash GET reads back",
    first.sourceRevision === 1 &&
      /^[0-9a-f]{64}$/.test(first.manifestHash ?? "") &&
      read?.manifestHash === first.manifestHash,
    JSON.stringify({ first: first, read: read?.manifestHash }),
  );
  const rerun = await sync("v1", source("export const a = 1;\n"));
  assertStep(
    "a rerun on the same source keeps its revision and hash",
    rerun.sourceRevision === 1 && rerun.manifestHash === first.manifestHash,
    JSON.stringify(rerun),
  );
  const edited = await sync("v1", source("export const a = 2;\n"));
  const changed = await sync("v2", source("export const a = 2;\n"));
  assertStep(
    "a source edit is a new revision; only a manifest change moves the hash",
    edited.sourceRevision === 2 &&
      edited.manifestHash === first.manifestHash &&
      changed.sourceRevision === 2 &&
      changed.manifestHash !== first.manifestHash,
    JSON.stringify({ edited: edited, changed: changed }),
  );
  const refused = await sync("v3", {
    files: [{ path: "broods/.env.local", content: "SECRET=1\n" }],
  }).then(
    (): string => "stored",
    (error: unknown): string => String(error),
  );
  const after = await client.getManifest(project, "development");
  assertStep(
    "a source with a dot file is refused before anything syncs",
    refused.includes("broods/.env.local is not a source file") &&
      after?.manifestHash === changed.manifestHash,
    refused,
  );
}
