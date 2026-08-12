import { expect, test } from "bun:test";
import { BroodsSyncClient } from "../src/sync.ts";

function clientWith(handler: (url: string, init: RequestInit) => Response) {
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
    /no \/v1\/account\/stages route yet/,
  );
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
