import type { CliManifest } from "../../../packages/broods/src/contracts.ts";
import {
  BroodsSyncClient,
  ManifestConflictError,
  diffManifests,
} from "../../../packages/broods/src/sync.ts";
import { assertStep, type VerifyContext } from "../harness.ts";

/** Concurrent SDK deploys leave one complete manifest; a stale revision cannot overwrite it. */
export async function manifestSync(context: VerifyContext): Promise<void> {
  const client = new BroodsSyncClient({
    baseUrl: context.gatewayUrl,
    token: context.accountSecret,
  });
  const project = `sync-${context.runId}`;
  const manifests: CliManifest[] = ["first", "second"].map(
    (name): CliManifest => ({
      version: 1,
      project: project,
      stage: "development",
      resources: [
        {
          kind: "agent",
          name: name,
          config: {
            model: context.model.model,
            agent: { system: `You are ${name}.` },
          },
        },
        {
          kind: "mcp",
          name: name,
          config: { transport: "http", url: `https://example.com/${name}/mcp` },
        },
      ],
    }),
  );
  const results = await context.measure(
    "concurrent manifest sync",
    (): Promise<
      PromiseSettledResult<Awaited<ReturnType<typeof client.putManifest>>>[]
    > =>
      Promise.allSettled(
        manifests.map((manifest): ReturnType<typeof client.putManifest> =>
          client.putManifest(manifest, true),
        ),
      ),
  );
  assertStep(
    "a concurrent deploy completed",
    results.some((result): boolean => result.status === "fulfilled"),
    results
      .map((result): string =>
        result.status === "rejected" ? String(result.reason) : "completed",
      )
      .join("; "),
  );
  for (const result of results) {
    if (result.status === "rejected") {
      assertStep(
        "an overlapping deploy returned the SDK conflict error",
        result.reason instanceof ManifestConflictError,
        String(result.reason),
      );
    }
  }
  const remote = await client.getManifest(project, "development");
  assertStep(
    "the stage contains one complete manifest",
    remote !== null &&
      manifests.some(
        (manifest): boolean =>
          diffManifests(manifest, remote.manifest).length === 0,
      ),
    "concurrent deploys left mixed resources",
  );
  let staleRejected = false;
  try {
    await client.putManifest(manifests[0]!, true, false, 0);
  } catch (error) {
    staleRejected = error instanceof ManifestConflictError;
  }
  assertStep(
    "a stale revision is refused",
    staleRejected,
    "stale manifest was accepted",
  );
  const after = await client.getManifest(project, "development");
  assertStep(
    "the rejected sync preserved the manifest",
    after !== null &&
      diffManifests(remote.manifest, after.manifest).length === 0,
    "stale sync changed resources",
  );
}
