// Every `broods mcp` tool is generated from one registry table, so a single
// wrong entry ships dozens of wrong tools. These tests drive the server
// through a real MCP client over an in-memory transport: the tool list is the
// drift check, and the guards must reject before any network call happens.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { BroodsMcpServerOptions } from "../src/mcp.ts";
import { createBroodsMcpServer } from "../src/mcp.ts";
import { BroodsSyncClient } from "../src/sync.ts";

const CREDENTIAL_ENV_KEYS = [
  "BROODS_ACCOUNT_SECRET",
  "BROODS_SESSION_TOKEN",
] as const;

const savedEnv = Object.fromEntries(
  CREDENTIAL_ENV_KEYS.map((key) => [key, process.env[key]]),
);

let openClient: Client | undefined;

beforeEach(() => {
  for (const key of CREDENTIAL_ENV_KEYS) delete process.env[key];
});

afterEach(async () => {
  await openClient?.close();
  openClient = undefined;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("an account credential registers the config plane, without the destructive or CLI tools", async () => {
  const client = await connectWithSecret({});

  const names = await toolNames(client);
  expect(names).toContain("list-agents");
  expect(names).toContain("create-cron");
  expect(names).toContain("upload-skill");
  expect(names).toContain("assume-role");
  expect(names).toContain("get-account");
  expect(names).not.toContain("rotate-secret");
  expect(names).not.toContain("delete-project");
  expect(names).not.toContain("list-orgs");
});

test("allowDestructive registers rotate-secret and delete-project", async () => {
  const client = await connectWithSecret({
    allowDestructive: true,
    cli: syncClient(),
  });

  const names = await toolNames(client);
  expect(names).toContain("rotate-secret");
  expect(names).toContain("delete-project");
});

test("a stored login alone serves only the org, project and stage tools", async () => {
  const client = await connect({ cli: syncClient() });

  expect(await toolNames(client)).toEqual([
    "create-org",
    "create-stage",
    "list-orgs",
    "list-projects",
    "list-stages",
    "select-org",
  ]);
});

test("no credential at all fails at startup", () => {
  expect(() => createBroodsMcpServer({})).toThrow("needs a credential");
});

const GUARD_CASES = [
  {
    tool: "delete-agent",
    args: { id: "agent_x", confirm: false },
    refusal: "Refusing without confirm:true",
  },
  {
    tool: "list-mcp",
    args: {},
    refusal: "'project' and 'stage'",
  },
] as const;

for (const { tool, args, refusal } of GUARD_CASES) {
  test(`${tool} refuses without its guard satisfied`, async () => {
    const client = await connectWithSecret({});

    const result = await client.callTool({ name: tool, arguments: args });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(refusal);
  });
}

/** Serve a fresh server over a linked in-memory pair and hand back the connected client. */
async function connect(options: BroodsMcpServerOptions): Promise<Client> {
  const server = createBroodsMcpServer(options);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-test", version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  openClient = client;

  return client;
}

async function connectWithSecret(
  options: BroodsMcpServerOptions,
): Promise<Client> {
  process.env.BROODS_ACCOUNT_SECRET = "fp_acct_test";

  return await connect(options);
}

function resultText(result: { content?: unknown }): string {
  const content = result.content as Array<{ text?: string }>;

  return content.map((block) => block.text ?? "").join("\n");
}

/** Refuses in-process; no CLI-scope tool is ever called in these tests. */
function syncClient(): BroodsSyncClient {
  return new BroodsSyncClient({
    baseUrl: "http://stub.invalid",
    fetch: async () => {
      throw new Error("no network in tests");
    },
    token: "cli_test",
  });
}

async function toolNames(client: Client): Promise<string[]> {
  const result = await client.listTools();

  return result.tools.map((tool) => tool.name).sort();
}
