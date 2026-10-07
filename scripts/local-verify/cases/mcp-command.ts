import type { CliManifest } from "../../../packages/broods/src/contracts.ts";
import { BroodsSyncClient } from "../../../packages/broods/src/sync.ts";
import { assertStep, type VerifyContext } from "../harness.ts";

/**
 * An MCP server on a sandbox carries the stdio `command` its host spawns, and
 * the config plane refuses a `command` on a server that has none to spawn.
 * Config only, so it needs no model key and no MicroVM.
 */
export async function mcpCommand(context: VerifyContext): Promise<void> {
  const sync = new BroodsSyncClient({
    baseUrl: context.edgeUrl,
    token: context.accountSecret,
  });
  const project = `mcp-command-${context.runId}`;
  const manifest = (mcp: Record<string, unknown>): CliManifest => ({
    version: 1,
    project: project,
    stage: "development",
    resources: [
      {
        kind: "sandbox",
        name: "web",
        config: {
          provider: "lambda",
          persistent: true,
          image: "obscura",
          network: { mode: "allow-all" },
        },
      },
      { kind: "mcp", name: "obscura", config: mcp },
    ],
  });

  const synced = await context.measure(
    "sync an MCP server on a lambda sandbox",
    (): ReturnType<typeof sync.putManifest> =>
      sync.putManifest(
        manifest({
          transport: "machine",
          sandbox: "web",
          command: ["obscura", "mcp"],
        }),
        true,
      ),
  );
  const row = await context.account.getMcp(synced.ids.mcp.obscura ?? "");
  assertStep(
    "an MCP server on a sandbox keeps its command",
    JSON.stringify(row?.command) === JSON.stringify(["obscura", "mcp"]),
    JSON.stringify(row),
  );

  const serverId = synced.ids.mcp.obscura ?? "";
  const patched = await context.account.updateMcp(serverId, { sandbox: "web" });
  assertStep(
    "a PATCH that names only the sandbox keeps the command",
    JSON.stringify(patched?.command) === JSON.stringify(["obscura", "mcp"]),
    JSON.stringify(patched),
  );

  await sync.putManifest(
    manifest({ transport: "machine", sandbox: "web" }),
    true,
  );
  const dropped = await context.account.getMcp(serverId);
  assertStep(
    "a sync whose definition drops the command clears it",
    dropped?.command === undefined,
    JSON.stringify(dropped),
  );

  const refused = await sync
    .putManifest(
      manifest({
        transport: "http",
        url: "https://example.com/mcp",
        command: ["obscura", "mcp"],
      }),
      true,
    )
    .then(
      (): string => "synced",
      (error: unknown): string => String(error),
    );
  assertStep(
    "a command on a remote MCP server is refused",
    refused.includes("command applies to a server on a sandbox"),
    refused,
  );
}
