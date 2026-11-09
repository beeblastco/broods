import { afterEach, beforeEach, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { MCP_PROTOCOL_VERSION } from "../../../apps/core/src/shared/mcp-protocol.ts";
import { BroodsAccountClient } from "../src/account.ts";
import type { BroodsMcpServerOptions } from "../src/mcp.ts";
import { createBroodsMcpServer, serveBroodsMcp } from "../src/mcp.ts";
import { BroodsSyncClient } from "../src/sync.ts";
import type { McpServer } from "@modelcontextprotocol/server";

const CREDENTIAL_ENV_KEYS = [
  "BROODS_ACCOUNT_SECRET",
  "BROODS_SESSION_TOKEN",
] as const;

const savedEnv = Object.fromEntries(
  CREDENTIAL_ENV_KEYS.map(
    (
      key,
    ): [
      "BROODS_SESSION_TOKEN" | "BROODS_ACCOUNT_SECRET",
      string | undefined,
    ] => [key, process.env[key]],
  ),
);

let openClient: Client | undefined;

beforeEach((): void => {
  for (const key of CREDENTIAL_ENV_KEYS) delete process.env[key];
});

afterEach(async (): Promise<void> => {
  await openClient?.close();
  openClient = undefined;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("a stored login alone still reads logs, traces, runs, audit and usage", async (): Promise<void> => {
  const client = await connect({
    login: new BroodsAccountClient({
      baseUrl: "http://127.0.0.1:9",
      sessionToken: "bcli_test",
    }),
  });

  const names = await toolNames(client);
  for (const tool of [
    "read-logs",
    "read-trace",
    "list-runs",
    "read-audit",
    "read-usage",
  ])
    expect(names).toContain(tool);
  expect(names).not.toContain("list-resources");
});

test("audit answers to the shell's credential, so a role's policy still bounds it beside a login", async (): Promise<void> => {
  process.env.BROODS_SESSION_TOKEN = "bsts_role";
  const seen: (string | null)[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (
    _url: string,
    init: RequestInit,
  ): Promise<Response> => {
    seen.push(new Headers(init.headers).get("authorization"));

    return Response.json({ events: [], nextSince: 0, head: null });
  }) as typeof fetch;
  try {
    const client = await connect({
      login: new BroodsAccountClient({
        baseUrl: "http://127.0.0.1:9",
        sessionToken: "bcli_someone_else",
      }),
    });
    await client.callTool({ name: "read-audit", arguments: {} });
  } finally {
    globalThis.fetch = realFetch;
  }

  expect(seen.length).toBeGreaterThan(0);
  expect(new Set(seen)).toEqual(new Set(["Bearer bsts_role"]));
});

test("an account credential registers the config plane, without the destructive or CLI tools", async (): Promise<void> => {
  const client = await connectWithSecret({});

  const names = await toolNames(client);
  expect(names).toContain("list-resources");
  expect(names).toContain("create-resource");
  expect(names).toContain("sandbox-action");
  expect(names.length).toBeLessThanOrEqual(25);
  expect(names).toContain("upload-skill");
  expect(names).toContain("assume-role");
  expect(names).toContain("get-account");
  expect(names).not.toContain("rotate-secret");
  expect(names).not.toContain("delete-project");
  expect(names).not.toContain("list-orgs");
});

test("allowDestructive registers rotate-secret and delete-project", async (): Promise<void> => {
  const client = await connectWithSecret({
    allowDestructive: true,
    cli: syncClient(),
  });

  const names = await toolNames(client);
  expect(names).toContain("rotate-secret");
  expect(names).toContain("delete-project");
});

test("a stored login alone serves only the org, project and stage tools", async (): Promise<void> => {
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

test("no credential at all fails at startup", (): void => {
  expect((): McpServer => createBroodsMcpServer({})).toThrow(
    "needs a credential",
  );
});

const GUARD_CASES = [
  {
    tool: "delete-resource",
    args: { resource: "agent", id: "agent_x", confirm: false },
    refusal: "Refusing without confirm:true",
  },
  {
    tool: "list-resources",
    args: { resource: "mcp" },
    refusal: "'project' and 'stage'",
  },
] as const;

test("a client on a 2025-era revision is refused with -32022", async (): Promise<void> => {
  process.env.BROODS_ACCOUNT_SECRET = "bask_test";

  await expect(connect({}, false)).rejects.toMatchObject({ code: -32022 });
});

test.each(GUARD_CASES)(
  "$tool refuses without its guard satisfied",
  async ({ tool, args, refusal }): Promise<void> => {
    const client = await connectWithSecret({});

    const result = await client.callTool({ name: tool, arguments: args });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(refusal);
  },
);

async function connect(
  options: BroodsMcpServerOptions,
  pinned = true,
): Promise<Client> {
  const server = createBroodsMcpServer(options);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  serveBroodsMcp(server, serverTransport);
  const client = new Client(
    { name: "mcp-test", version: "1" },
    pinned
      ? { versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } }
      : {},
  );
  openClient = client;
  await client.connect(clientTransport);

  return client;
}

async function connectWithSecret(
  options: BroodsMcpServerOptions,
): Promise<Client> {
  process.env.BROODS_ACCOUNT_SECRET = "bask_test";

  return await connect(options);
}

function resultText(result: { content?: unknown }): string {
  const content = result.content as Array<{ text?: string }>;

  return content.map((block): string => block.text ?? "").join("\n");
}

function syncClient(): BroodsSyncClient {
  return new BroodsSyncClient({
    baseUrl: "http://stub.invalid",
    fetch: async (): Promise<never> => {
      throw new Error("no network in tests");
    },
    token: "cli_test",
  });
}

async function toolNames(client: Client): Promise<string[]> {
  const result = await client.listTools();

  return result.tools.map((tool): string => tool.name).sort();
}
