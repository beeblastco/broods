import { expect, test } from "bun:test";
import { FilthyPantySyncClient } from "../src/sync.ts";

function clientWith(handler: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; method: string }> = [];
  const client = new FilthyPantySyncClient({
    dashboardUrl: "https://dashboard.example.com",
    token: "tok",
    fetch: async (input, init) => {
      const url = String(input);
      calls.push({ url: url, method: (init?.method ?? "GET").toUpperCase() });
      return handler(url, init ?? {});
    },
  });

  return { client: client, calls: calls };
}

test("listEnv GETs the env collection and returns variable names", async () => {
  const { client, calls } = clientWith(() =>
    new Response(JSON.stringify({ variables: [{ name: "OPENAI_API_KEY", updatedAt: 1 }] })),
  );

  const variables = await client.listEnv("demo-app", "development");

  expect(variables).toEqual([{ name: "OPENAI_API_KEY", updatedAt: 1 }]);
  expect(calls[0]).toEqual({
    url: "https://dashboard.example.com/api/cli/projects/demo-app/environments/development/env",
    method: "GET",
  });
});

test("listEnv returns an empty array when the payload omits variables", async () => {
  const { client } = clientWith(() => new Response(JSON.stringify({})));

  expect(await client.listEnv("demo-app", "development")).toEqual([]);
});

test("getEnv GETs the named env var and returns its value", async () => {
  const { client, calls } = clientWith(() => new Response(JSON.stringify({ value: "sk-secret" })));

  const value = await client.getEnv("demo-app", "development", "OPENAI_API_KEY");

  expect(value).toBe("sk-secret");
  expect(calls[0]).toEqual({
    url: "https://dashboard.example.com/api/cli/projects/demo-app/environments/development/env/OPENAI_API_KEY",
    method: "GET",
  });
});

test("getEnv returns null when the var is not set (404)", async () => {
  const { client } = clientWith(() => new Response("not found", { status: 404 }));

  expect(await client.getEnv("demo-app", "development", "MISSING")).toBeNull();
});

test("removeEnv DELETEs the named env var", async () => {
  const { client, calls } = clientWith(() => new Response(JSON.stringify({ removed: true })));

  await client.removeEnv("demo-app", "development", "OPENAI_API_KEY");

  expect(calls[0]).toEqual({
    url: "https://dashboard.example.com/api/cli/projects/demo-app/environments/development/env/OPENAI_API_KEY",
    method: "DELETE",
  });
});

test("removeEnv throws on a non-ok response", async () => {
  const { client } = clientWith(() => new Response("nope", { status: 500 }));

  await expect(client.removeEnv("demo-app", "development", "X")).rejects.toThrow(
    "Remove environment variable failed",
  );
});
