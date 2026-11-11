import { BroodsClient } from "../../../packages/broods/src/client.ts";
import type { CliManifest } from "../../../packages/broods/src/contracts.ts";
import {
  BroodsSyncClient,
  ManifestConflictError,
  diffManifests,
} from "../../../packages/broods/src/sync.ts";
import { assertStep, type VerifyContext } from "../harness.ts";

export async function manifestSync(context: VerifyContext): Promise<void> {
  const client = new BroodsSyncClient({
    baseUrl: context.edgeUrl,
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
  const winner = manifests.find(
    (manifest): boolean => diffManifests(manifest, after.manifest).length === 0,
  );
  const [agent, mcp] = winner?.resources ?? [];
  const cron = {
    kind: "cron" as const,
    name: "daily",
    config: {
      agentId: agent?.name ?? "",
      events: [{ role: "user", content: "Report." }],
      scheduleExpression: "rate(1 day)",
    },
  };
  const withCron = await client.putManifest(
    { ...manifests[0]!, resources: [...(winner?.resources ?? []), cron] },
    false,
    false,
    after.revision,
  );
  await client.putManifest(
    { ...manifests[0]!, resources: [] },
    [
      { kind: "mcp", name: mcp?.name ?? "" },
      { kind: "cron", name: cron.name },
    ],
    false,
    withCron.revision,
  );
  const pruned = (
    await client.getManifest(project, "development")
  )?.manifest.resources.map(
    (resource): string => `${resource.kind}:${resource.name}`,
  );
  assertStep(
    "a prune list removes only the resources it names",
    pruned?.includes(`agent:${agent?.name}`) === true &&
      !pruned.includes(`mcp:${mcp?.name}`) &&
      !pruned.includes(`cron:${cron.name}`),
    JSON.stringify(pruned),
  );
  const runtimeKey = await client.getRuntimeKey(project, "development");
  const runtime = new BroodsClient({
    apiKey: runtimeKey?.apiKey,
    baseUrl: context.edgeUrl,
  });
  // A 401 throws; an unknown run is only reachable past auth.
  const status = await runtime
    .getAsyncStatus(`run_${"0".repeat(32)}`)
    .catch((error: unknown): string => String(error));
  assertStep(
    "the runtime key authenticates on core",
    typeof status !== "string" && status.status === "not_found",
    JSON.stringify(status),
  );
  const lowercase = await client
    .setEnv(project, "development", "api_key", "sk-verify")
    .then(
      (): string => "accepted",
      (error: unknown): string => String(error),
    );
  const stored = await client.listEnv(project, "development");
  assertStep(
    "a lowercase stage env var name is refused and not stored",
    lowercase.includes("env name must match") &&
      !stored.some((variable): boolean => variable.name === "api_key"),
    lowercase,
  );
  // The sync checks each agent against the stored column shape before it writes any.
  const malformed = await client
    .putManifest(
      {
        version: 1,
        project: `${project}-shape`,
        stage: "development",
        resources: [
          {
            kind: "agent",
            name: "malformed",
            config: { model: context.model.model, sandboxes: "sb_offline" },
          },
        ],
      },
      true,
    )
    .then(
      (): string => "accepted",
      (error: unknown): string => String(error),
    );
  assertStep(
    "an agent config of the wrong shape is refused with its path",
    malformed.includes("config.sandboxes must be array"),
    malformed,
  );
  // No harness reads providerOptions, so the sync refuses them instead of storing them unused.
  const harnessOptions = await client
    .putManifest(
      {
        version: 1,
        project: `${project}-harness`,
        stage: "development",
        resources: [
          {
            kind: "sandbox",
            name: "box",
            config: { provider: "lambda", persistent: true },
          },
          {
            kind: "agent",
            name: "coder",
            config: {
              model: {
                ...context.model.model,
                providerOptions: {
                  anthropic: {
                    thinking: { type: "enabled", budgetTokens: 1024 },
                  },
                },
              },
              harness: { type: "pi" },
              sandboxes: ["box"],
            },
          },
        ],
      },
      true,
    )
    .then(
      (): string => "accepted",
      (error: unknown): string => String(error),
    );
  assertStep(
    "a harness agent with providerOptions is refused by name",
    harnessOptions.includes(
      "config.model.providerOptions is not supported with config.harness",
    ),
    harnessOptions,
  );
}
