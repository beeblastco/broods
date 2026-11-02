import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  Client,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { z } from "zod";
import { MCP_PROTOCOL_VERSION } from "../../../../apps/core/src/shared/mcp-protocol.ts";
import { agentEnv } from "../runtime-config.ts";

const CLIENT_INFO = { name: "broods-machine", version: "1.0.0" };
// Refuses a server that never answers `server/discover` before the SDK's 60s request timeout.
const DISCOVER_TIMEOUT_MS = 10_000;

const serverSpec = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
});

const serversFile = z.object({
  mcpServers: z
    .record(z.string(), serverSpec)
    .refine(
      (servers) => Object.keys(servers).length > 0,
      "lists no MCP servers",
    ),
});

export type McpServerSpec = z.infer<typeof serverSpec>;

// Servers must speak MCP 2026-07-28, no 2025-era fallback. Core only sees names, tool
// listings and results: the file and its command lines stay on this computer.
export class McpHost {
  readonly #clients = new Map<string, Promise<Client>>();
  readonly #log: (line: string) => void;
  readonly #servers: ReadonlyMap<string, McpServerSpec>;

  constructor(
    servers: ReadonlyMap<string, McpServerSpec>,
    log: (line: string) => void,
  ) {
    this.#servers = servers;
    this.#log = log;
  }

  async callTool(
    server: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const client = await this.#client(server);

    return await client.callTool({ name: tool, arguments: args });
  }

  async listTools(server: string): Promise<Tool[]> {
    const client = await this.#client(server);

    return (await client.listTools()).tools;
  }

  names(): string[] {
    return [...this.#servers.keys()];
  }

  async stop(): Promise<void> {
    const clients = [...this.#clients.values()];
    this.#clients.clear();
    await Promise.all(
      clients.map((pending) =>
        pending.then((client) => client.close()).catch((): void => {}),
      ),
    );
  }

  // A server that exits is forgotten, so the next call respawns it instead of failing forever.
  #client(server: string): Promise<Client> {
    const spec = this.#servers.get(server);
    if (!spec) {
      return Promise.reject(
        new Error(`no MCP server named "${server}" in the --mcp file`),
      );
    }
    const existing = this.#clients.get(server);
    if (existing) return existing;
    const pending = (async (): Promise<Client> => {
      this.#log(`mcp ${server}: ${[spec.command, ...spec.args].join(" ")}`);
      const transport = new StdioClientTransport({
        ...spec,
        env: { ...agentEnv(), ...spec.env },
        stderr: "inherit",
      });
      transport.onclose = (): void => {
        this.#log(`mcp ${server}: exited`);
        if (this.#clients.get(server) === pending) this.#clients.delete(server);
      };
      const client = new Client(CLIENT_INFO, {
        versionNegotiation: {
          mode: { pin: MCP_PROTOCOL_VERSION },
          probe: { timeoutMs: DISCOVER_TIMEOUT_MS },
        },
      });
      await client.connect(transport);

      return client;
    })();
    pending.catch((): void => {
      if (this.#clients.get(server) === pending) this.#clients.delete(server);
    });
    this.#clients.set(server, pending);

    return pending;
  }
}

export function readMcpServersFile(path: string): Map<string, McpServerSpec> {
  const file = resolve(path);
  const parsed = serversFile.safeParse(readJson(file));
  if (!parsed.success) {
    throw new Error(`${file}: ${z.prettifyError(parsed.error)}`);
  }

  return new Map(
    Object.entries(parsed.data.mcpServers).map(([name, spec]) => [
      name,
      spec.cwd ? { ...spec, cwd: resolve(dirname(file), spec.cwd) } : spec,
    ]),
  );
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `could not read ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
