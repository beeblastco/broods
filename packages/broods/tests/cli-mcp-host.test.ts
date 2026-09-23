import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMachineDaemon } from "../src/cli/machine.ts";
import { McpHost, readMcpServersFile } from "../src/cli/mcp-host.ts";
import { startFakeCore } from "./fixtures/fake-core.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "echo-mcp-server.ts");
const hosts: McpHost[] = [];
const servers: Bun.Server<undefined>[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
  for (const server of servers.splice(0)) server.stop(true);
});

test("the host reads a .mcp.json, spawns the server on first use, lists and calls", async () => {
  const host = new McpHost(readMcpServersFile(mcpFile()), () => {});
  hosts.push(host);

  expect(host.names()).toEqual(["echo"]);
  expect((await host.listTools("echo")).map((tool) => tool.name)).toEqual([
    "echo",
  ]);
  expect(
    (await host.callTool("echo", "echo", { text: "pong" })).content,
  ).toEqual([{ type: "text", text: "echo: pong" }]);
  await expect(host.listTools("nope")).rejects.toThrow(
    'no MCP server named "nope"',
  );
});

test("a bad file fails before any server runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "broods-mcp-"));
  const file = join(dir, "mcp.json");

  writeFileSync(file, JSON.stringify({ mcpServers: { bad: { args: [] } } }));
  expect(() => readMcpServersFile(file)).toThrow("mcpServers.bad.command");
  writeFileSync(file, JSON.stringify({ servers: {} }));
  expect(() => readMcpServersFile(file)).toThrow("mcpServers");
  writeFileSync(file, "{");
  expect(() => readMcpServersFile(file)).toThrow("could not read");
});

test("a daemon started with --mcp advertises its servers and answers both frames", async () => {
  const core = startFakeCore((frame) => {
    if (frame.type === "hello") {
      return { type: "mcp-list", id: "l1", server: "echo" };
    }
    if (frame.type === "mcp-tools") {
      return {
        type: "mcp-call",
        id: "c1",
        server: "echo",
        tool: "echo",
        args: { text: "hi" },
      };
    }

    return null;
  });
  servers.push(core.server);

  await expect(
    runMachineDaemon({
      credential: async (): Promise<string> => "key",
      baseUrl: core.url,
      cwd: process.cwd(),
      log: () => {},
      mcpFile: mcpFile(),
      sandbox: "my-mac",
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("Replaced by a newer connection");

  expect(core.received[0]).toMatchObject({ type: "hello", mcp: ["echo"] });
  expect(core.received[1]).toMatchObject({
    type: "mcp-tools",
    tools: [{ name: "echo" }],
  });
  expect(core.received[2]).toMatchObject({
    type: "mcp-result",
    result: { content: [{ type: "text", text: "echo: hi" }] },
  });
});

function mcpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "broods-mcp-"));
  const file = join(dir, "mcp.json");
  writeFileSync(
    file,
    JSON.stringify({
      mcpServers: { echo: { command: "bun", args: [FIXTURE] } },
    }),
  );

  return file;
}
