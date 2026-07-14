import { expect, test } from "bun:test";
import { BroodsAccountApiError, BroodsAccountClient, envPlaceholder } from "../src/account.ts";

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

function mockClient(responses: Array<{ status: number; body: unknown }>) {
  const calls: Call[] = [];
  const client = new BroodsAccountClient({
    baseUrl: "https://gateway.example.com/",
    accountSecret: "secret-1",
    fetch: async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers: (init?.headers ?? {}) as Record<string, string>,
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      });
      const next = responses.shift() ?? { status: 200, body: {} };
      return new Response(JSON.stringify(next.body), { status: next.status });
    },
  });

  return { client, calls };
}

test("sends bearer auth and strips the trailing slash from baseUrl", async () => {
  const { client, calls } = mockClient([
    { status: 200, body: { agents: [] } },
  ]);

  const agents = await client.listAgents();

  expect(agents).toEqual([]);
  expect(calls[0]?.url).toBe("https://gateway.example.com/v1/agents");
  expect(calls[0]?.headers.Authorization).toBe("Bearer secret-1");
});

test("get/update return null on 404 so callers can upsert", async () => {
  const { client } = mockClient([
    { status: 404, body: { error: "Agent not found" } },
    { status: 404, body: { error: "Agent not found" } },
  ]);

  expect(await client.getAgent("agent_missing")).toBeNull();
  expect(await client.updateAgent("agent_missing", { config: {} })).toBeNull();
});

test("non-2xx non-404 responses throw BroodsAccountApiError with status", async () => {
  const { client } = mockClient([
    { status: 401, body: { error: "Unauthorized" } },
  ]);

  expect(client.listCrons()).rejects.toThrow(BroodsAccountApiError);
});

test("createAgent posts JSON and unwraps the created record", async () => {
  const { client, calls } = mockClient([
    { status: 201, body: { accountId: "acc_1", agentId: "agent_1", name: "tenant-a" } },
  ]);

  const created = await client.createAgent({ name: "tenant-a", config: { publicAccess: true } });

  expect(created.agentId).toBe("agent_1");
  expect(calls[0]?.method).toBe("POST");
  expect(calls[0]?.headers["Content-Type"]).toBe("application/json");
  expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ name: "tenant-a", config: { publicAccess: true } });
});

test("account env vars: list, set, and delete use write-only config-plane routes", async () => {
  const { client, calls } = mockClient([
    { status: 200, body: { env: [{ name: "OVH_API_KEY", updatedAt: 123 }] } },
    { status: 200, body: { name: "OVH_API_KEY" } },
    { status: 200, body: { deleted: true } },
  ]);

  expect(await client.listEnvVars()).toEqual([{ name: "OVH_API_KEY", updatedAt: 123 }]);
  await client.setEnvVar("OVH_API_KEY", "secret-value");
  expect(await client.deleteEnvVar("OVH_API_KEY")).toBe(true);
  expect(calls.map((call) => [call.method, call.url])).toEqual([
    ["GET", "https://gateway.example.com/v1/env"],
    ["PUT", "https://gateway.example.com/v1/env/OVH_API_KEY"],
    ["DELETE", "https://gateway.example.com/v1/env/OVH_API_KEY"],
  ]);
  expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({ value: "secret-value" });
});

test("envPlaceholder validates account env-var names", () => {
  expect(envPlaceholder("OVH_API_KEY")).toBe("${OVH_API_KEY}");
  expect(() => envPlaceholder("lowercase")).toThrow();
  expect(() => envPlaceholder("A".repeat(65))).toThrow();
});

test("unwraps list envelopes for crons, runs, workspaces, and files", async () => {
  const { client, calls } = mockClient([
    { status: 200, body: { crons: [{ cronId: "cron_1" }] } },
    { status: 200, body: { runs: [{ runId: "run_1" }] } },
    { status: 200, body: { workspaces: [{ workspaceId: "ws_1" }] } },
    { status: 200, body: { files: [{ path: "memory/notes.md", name: "notes.md", isFolder: false }] } },
  ]);

  expect((await client.listCrons())[0]?.cronId).toBe("cron_1");
  expect((await client.listCronRuns("cron_1", { limit: 5 }))[0]?.runId).toBe("run_1");
  expect((await client.listWorkspaces())[0]?.workspaceId).toBe("ws_1");
  expect((await client.listWorkspaceFiles("ws_1"))[0]?.name).toBe("notes.md");
  expect(calls[1]?.url).toBe("https://gateway.example.com/v1/crons/cron_1/runs?limit=5");
});

test("getAccount unwraps the account envelope", async () => {
  const { client } = mockClient([
    { status: 200, body: { account: { accountId: "acc_1", username: "beeblast", status: "active" } } },
  ]);

  const account = await client.getAccount();
  expect(account.accountId).toBe("acc_1");
});

test("webhookUrl builds the per-account per-agent channel path", () => {
  const { client } = mockClient([]);

  expect(client.webhookUrl("acc 1", "agent/1", "slack")).toBe(
    "https://gateway.example.com/webhooks/acc%201/agent%2F1/slack",
  );
});

test("constructor requires accountSecret when env vars are absent", () => {
  const savedBaseUrl = process.env.BROODS_BASE_URL;
  const savedSecret = process.env.BROODS_ACCOUNT_SECRET;
  delete process.env.BROODS_BASE_URL;
  delete process.env.BROODS_ACCOUNT_SECRET;
  try {
    expect(() => new BroodsAccountClient()).toThrow();
  } finally {
    if (savedBaseUrl !== undefined) process.env.BROODS_BASE_URL = savedBaseUrl;
    if (savedSecret !== undefined) process.env.BROODS_ACCOUNT_SECRET = savedSecret;
  }
});

test("account metadata: update unwraps, delete returns cleanup, rotate returns the new secret", async () => {
  const { client, calls } = mockClient([
    { status: 200, body: { account: { accountId: "acc_1", username: "renamed", status: "active" } } },
    { status: 200, body: { deleted: true, cleanup: { agentsDeleted: 2, cronsDeleted: 1 } } },
    { status: 200, body: { account: { accountId: "acc_1", username: "renamed", status: "active" }, secret: "fp_acct_new" } },
  ]);

  const updated = await client.updateAccount({ username: "renamed" });
  expect(updated?.username).toBe("renamed");
  expect(calls[0]?.method).toBe("PATCH");

  const deleted = await client.deleteAccount();
  expect(deleted.deleted).toBe(true);
  expect(deleted.cleanup?.agentsDeleted).toBe(2);

  const rotated = await client.rotateSecret();
  expect(rotated.secret).toBe("fp_acct_new");
  expect(calls[2]?.url).toBe("https://gateway.example.com/v1/account/rotate-secret");
});

test("sandboxes: list/create unwrap, get returns null on 404", async () => {
  const { client, calls } = mockClient([
    { status: 200, body: { sandboxes: [{ sandboxId: "sb_1", name: "default" }] } },
    { status: 201, body: { sandboxId: "sb_2", name: "reserved" } },
    { status: 404, body: { error: "Sandbox not found" } },
  ]);

  expect((await client.listSandboxes())[0]?.sandboxId).toBe("sb_1");
  expect((await client.createSandbox({ name: "reserved", config: { provider: "lambda" } })).sandboxId).toBe("sb_2");
  expect(await client.getSandbox("sb_missing")).toBeNull();
  expect(calls[0]?.url).toBe("https://gateway.example.com/v1/sandboxes");
});

test("sandbox lifecycle: suspend posts the reservationKey and returns status", async () => {
  const { client, calls } = mockClient([
    { status: 200, body: { status: "suspended" } },
    { status: 200, body: { token: "tkt_1", expiresAt: 123, websocketPath: "/v1/sandboxes/terminal/ws" } },
  ]);

  const suspended = await client.suspendSandbox("sb_1", "ws-namespace");
  expect(suspended.status).toBe("suspended");
  expect(calls[0]?.method).toBe("POST");
  expect(calls[0]?.url).toBe("https://gateway.example.com/v1/sandboxes/sb_1/suspend");
  expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ reservationKey: "ws-namespace" });

  const ticket = await client.openSandboxTerminal("sb_1", "ws-namespace");
  expect(ticket.token).toBe("tkt_1");
  expect(calls[1]?.url).toBe("https://gateway.example.com/v1/sandboxes/sb_1/terminal");
});

test("sandbox lifecycle throws on a missing sandbox (404)", async () => {
  const { client } = mockClient([{ status: 404, body: { error: "Sandbox not found" } }]);

  expect(client.terminateSandbox("sb_missing", "key")).rejects.toThrow(BroodsAccountApiError);
});

test("tools: create posts JSON with the bundle and delete returns the flag", async () => {
  const { client, calls } = mockClient([
    { status: 201, body: { toolId: "qs78zwc4z4q5ysxm74fgrhd13s88xxt", name: "sum", runtime: "isolate" } },
    { status: 200, body: { deleted: true } },
  ]);

  const created = await client.createTool({ name: "sum", description: "adds", inputSchema: {}, bundle: "export default {}" });
  expect(created.toolId).toBe("qs78zwc4z4q5ysxm74fgrhd13s88xxt");
  expect(calls[0]?.headers["Content-Type"]).toBe("application/json");
  expect(JSON.parse(calls[0]?.body ?? "{}").bundle).toBe("export default {}");

  expect(await client.deleteTool("qs78zwc4z4q5ysxm74fgrhd13s88xxt")).toBe(true);
});

test("policies: list/create unwrap and get returns null on 404", async () => {
  const { client } = mockClient([
    { status: 200, body: { policies: [{ policyId: "pol_1", name: "guard" }] } },
    { status: 201, body: { policyId: "pol_2", name: "guard2" } },
    { status: 404, body: { error: "Policy not found" } },
  ]);

  expect((await client.listPolicies())[0]?.policyId).toBe("pol_1");
  expect((await client.createPolicy({ name: "guard2", document: { version: 1, rules: [] } as never })).policyId).toBe("pol_2");
  expect(await client.getPolicy("pol_missing")).toBeNull();
});

test("skills: list unwraps, upload uses PUT, delete returns the flag", async () => {
  const { client, calls } = mockClient([
    { status: 200, body: { skills: [{ path: "acc_1/flow", name: "flow", description: "d" }] } },
    { status: 200, body: { path: "acc_1/flow", name: "flow", description: "updated" } },
    { status: 200, body: { deleted: true } },
  ]);

  expect((await client.listSkills())[0]?.name).toBe("flow");

  const uploaded = await client.uploadSkill("flow", { source: "json", name: "flow", description: "updated", content: "# Flow" });
  expect(uploaded.description).toBe("updated");
  expect(calls[1]?.method).toBe("PUT");
  expect(calls[1]?.url).toBe("https://gateway.example.com/v1/skills/flow");

  expect(await client.deleteSkill("flow")).toBe(true);
});

test("workspace files: upload unwraps the file, rename and delete return flags", async () => {
  const { client, calls } = mockClient([
    { status: 201, body: { file: { path: "memory/notes.md", name: "notes.md", isFolder: false } } },
    { status: 200, body: { renamed: true } },
    { status: 200, body: { deleted: true } },
    { status: 200, body: { url: "https://s3.example.com/signed" } },
  ]);

  const file = await client.uploadWorkspaceFile("ws_1", { path: "memory/notes.md", contentBase64: "aGk=" });
  expect(file.name).toBe("notes.md");
  expect(calls[0]?.method).toBe("POST");

  expect(await client.renameWorkspaceFile("ws_1", "memory/notes.md", "memory/renamed.md")).toBe(true);
  expect(calls[1]?.method).toBe("PATCH");

  expect(await client.deleteWorkspaceFile("ws_1", "memory/renamed.md")).toBe(true);
  expect(calls[2]?.method).toBe("DELETE");

  expect(await client.getWorkspaceFileUrl("ws_1", "memory/renamed.md")).toBe("https://s3.example.com/signed");
  expect(calls[3]?.url).toBe("https://gateway.example.com/v1/workspaces/ws_1/files?path=memory%2Frenamed.md");
});

test("baseUrl defaults to the managed gateway when option and env var are absent", () => {
  const savedBaseUrl = process.env.BROODS_BASE_URL;
  delete process.env.BROODS_BASE_URL;
  try {
    const client = new BroodsAccountClient({ accountSecret: "fp_acct_test" });
    expect(client.webhookUrl("acc1", "agent1", "slack")).toBe(
      "https://gateway.broods.app/webhooks/acc1/agent1/slack",
    );
  } finally {
    if (savedBaseUrl !== undefined) process.env.BROODS_BASE_URL = savedBaseUrl;
  }
});
