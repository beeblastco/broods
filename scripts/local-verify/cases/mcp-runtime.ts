import type { CliManifest } from "../../../packages/broods/src/contracts.ts";
import { BroodsSyncClient } from "../../../packages/broods/src/sync.ts";
import { assertStep, type VerifyContext } from "../harness.ts";

/**
 * The Cloudflare MCP runtime is per hosted row and opt-in: both config-plane
 * write paths (manifest sync, PATCH /v1/mcp) refuse it on any other row.
 * A hosted upload needs the tool-bundles bucket, which the local stack has
 * not got, so the accepted path is covered by the convex and core tests.
 */
export async function mcpRuntime(context: VerifyContext): Promise<void> {
  const sync = new BroodsSyncClient({
    baseUrl: context.gatewayUrl,
    token: context.accountSecret,
  });
  const project = `mcp-runtime-${context.runId}`;
  const manifest = (config: Record<string, unknown>): CliManifest => ({
    version: 1,
    project: project,
    stage: "development",
    resources: [{ kind: "mcp", name: "search", config: config }],
  });
  const url = "https://example.com/mcp";
  const refused = await sync
    .putManifest(manifest({ url: url, runtime: "cloudflare" }), true)
    .then(
      (): string => "accepted",
      (error: unknown): string => String(error),
    );
  assertStep(
    "manifest sync refuses a runtime on an external server",
    refused.includes("runtime applies only to hosted MCP servers"),
    refused,
  );
  await sync.putManifest(manifest({ url: url }), true);
  const [server] = await context.account.listMcp({
    project: project,
    stage: "development",
  });
  assertStep(
    "the external server synced without a runtime",
    server !== undefined && server.runtime === undefined,
    JSON.stringify(server),
  );
  const patched = await context.account
    .updateMcp(server!.serverId, { runtime: "cloudflare" })
    .then(
      (): string => "accepted",
      (error: unknown): string => String(error),
    );
  assertStep(
    "PATCH refuses a runtime on an external server",
    patched.includes("runtime applies only to hosted MCP servers"),
    patched,
  );
}
