/**
 * `broods machine --mcp <file>`: the daemon as MCP host. The file has the
 * `.mcp.json` shape Claude Code, Cursor and Codex read, so a server already
 * set up for them works here unchanged. Each server is a stdio child the SDK
 * client spawns on first use and keeps. Core only ever learns names, tool
 * listings and results: the file and its command lines stay on this computer.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  Client,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { z } from "zod";

const CLIENT_INFO = { name: "broods-machine", version: "1.0.0" };

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

    return (await client.callTool({
      name: tool,
      arguments: args,
    })) as CallToolResult;
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

  // Spawned on first use and kept. A server that exits is forgotten, so the
  // next call spawns it again instead of failing forever.
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
        env: { ...inheritedEnv(), ...spec.env },
        stderr: "inherit",
      });
      transport.onclose = (): void => {
        this.#log(`mcp ${server}: exited`);
        if (this.#clients.get(server) === pending) this.#clients.delete(server);
      };
      const client = new Client(CLIENT_INFO);
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

/** Parse a `.mcp.json`; a relative `cwd` resolves against the file. */
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

// The servers run as the user, with the user's own environment.
function inheritedEnv(): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (typeof value === "string") entries[name] = value;
  }

  return entries;
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
