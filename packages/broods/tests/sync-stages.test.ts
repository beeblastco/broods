import { expect, test } from "bun:test";
import { BroodsSyncClient } from "../src/sync.ts";

function clientWith(handler: (url: string, init: RequestInit) => Response): {
  client: BroodsSyncClient;
  calls: Array<{ url: string; method: string; body?: string }>;
} {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const client = new BroodsSyncClient({
    baseUrl: "https://convex.example.com",
    token: "tok",
    fetch: async (input, init) => {
      const url = String(input);
      calls.push({
        url: url,
        method: (init?.method ?? "GET").toUpperCase(),
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      });

      return handler(url, init ?? {});
    },
  });

  return { client: client, calls: calls };
}

const STAGE = {
  id: "env_1",
  name: "Development",
  kind: "development" as const,
  isDefault: true,
  agentCount: 2,
  variableCount: 3,
  updatedAt: 1,
};

test("listStages passes the project as a query parameter", async () => {
  const { client, calls } = clientWith(
    () => new Response(JSON.stringify({ stages: [STAGE] })),
  );

  const stages = await client.listStages("client lamy");

  expect(stages).toEqual([STAGE]);
  expect(calls[0]).toEqual({
    url: "https://convex.example.com/v1/account/stages?project=client%20lamy",
    method: "GET",
  });
});

test("listStages returns an empty array when the payload omits stages", async () => {
  const { client } = clientWith(() => new Response(JSON.stringify({})));

  expect(await client.listStages("demo-app")).toEqual([]);
});

test("createStage posts the project, name and clone source", async () => {
  const { client, calls } = clientWith(
    () =>
      new Response(JSON.stringify({ stage: STAGE, clonedFrom: "Development" })),
  );

  const created = await client.createStage(
    "demo-app",
    "staging",
    "development",
  );

  expect(created.clonedFrom).toBe("Development");
  expect(calls[0]?.method).toBe("POST");
  expect(calls[0]?.url).toBe("https://convex.example.com/v1/account/stages");
  expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
    project: "demo-app",
    name: "staging",
    from: "development",
  });
});

test("createStage omits `from` when no clone source is given", async () => {
  const { client, calls } = clientWith(
    () => new Response(JSON.stringify({ stage: STAGE, clonedFrom: null })),
  );

  await client.createStage("demo-app", "staging");

  expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
    project: "demo-app",
    name: "staging",
  });
});

test("createStage surfaces the server error message", async () => {
  const { client } = clientWith(
    () =>
      new Response(JSON.stringify({ error: "Stage Staging already exists" }), {
        status: 400,
      }),
  );

  await expect(client.createStage("demo-app", "staging")).rejects.toThrow(
    /Stage Staging already exists/,
  );
});

// `stage list` marks the current stage and `stage use` matches a name against
// this payload, so a 404 that the router (not the handler) produced has to read
// as "route missing", not "project missing".
test("listStages rejects a non-JSON 404 as a missing stages route", async () => {
  const { client } = clientWith(
    () => new Response("Not Found", { status: 404 }),
  );

  await expect(client.listStages("demo-app")).rejects.toThrow(
    /older than your CLI .*no \/v1\/account\/stages route/,
  );
});

// Node's bare "fetch failed" hid which server was down and why.
test("a network failure names the server and the cause", async () => {
  const client = new BroodsSyncClient({
    baseUrl: "https://convex.example.com",
    token: "tok",
    fetch: async () => {
      throw new TypeError("fetch failed", {
        cause: new Error("connect ECONNREFUSED 10.0.0.1:443"),
      });
    },
  });

  await expect(client.listStages("demo-app")).rejects.toThrow(
    "Cannot reach https://convex.example.com: connect ECONNREFUSED 10.0.0.1:443",
  );
});

// A sync can hold the connection for minutes; every other call gives up.
test("requests time out, except the manifest write", async () => {
  const signals: Array<AbortSignal | null | undefined> = [];
  const { client } = clientWith((_url, init) => {
    signals.push(init.signal);

    return Response.json({ stages: [], manifest: {}, ids: {} });
  });

  await client.listStages("demo-app");
  await client.putManifest(
    { version: 1, project: "demo-app", stage: "development", resources: [] },
    false,
  );

  expect(signals[0]).toBeInstanceOf(AbortSignal);
  expect(signals[1]).toBeUndefined();
});

test("listStages surfaces a JSON 404 as a normal request failure", async () => {
  const { client } = clientWith(
    () =>
      new Response(
        JSON.stringify({ error: "Project demo-app was not found" }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        },
      ),
  );

  await expect(client.listStages("demo-app")).rejects.toThrow(
    /Project demo-app was not found/,
  );
});

// CLI tokens expire after 90 days, and the bare 401 did not say what to do.
test("a 401 tells the user to log in again", async () => {
  const { client } = clientWith(
    () =>
      new Response(JSON.stringify({ error: { message: "Unauthorized" } }), {
        status: 401,
      }),
  );

  await expect(client.listStages("demo-app")).rejects.toThrow(
    "List stages failed: 401 Unauthorized\nRun `broods login` to sign in again.",
  );
});
