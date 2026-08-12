import { expect, test } from "bun:test";
import { BroodsSyncClient } from "../src/sync.ts";

function clientWith(handler: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; method: string }> = [];
  const client = new BroodsSyncClient({
    baseUrl: "https://convex.example.com",
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
  const { client, calls } = clientWith(
    () =>
      new Response(
        JSON.stringify({
          variables: [{ name: "OPENAI_API_KEY", updatedAt: 1 }],
        }),
      ),
  );

  const variables = await client.listEnv("demo-app", "development");

  expect(variables).toEqual([{ name: "OPENAI_API_KEY", updatedAt: 1 }]);
  expect(calls[0]).toEqual({
    url: "https://convex.example.com/v1/account/projects/demo-app/stages/development/env",
    method: "GET",
  });
});

test("listEnv returns an empty array when the payload omits variables", async () => {
  const { client } = clientWith(() => new Response(JSON.stringify({})));

  expect(await client.listEnv("demo-app", "development")).toEqual([]);
});

test("getRuntimeKey recovers the stage runtime key", async () => {
  const { client, calls } = clientWith(
    () =>
      new Response(
        JSON.stringify({
          apiKey: "fp_agent_secret",
          keyHint: "fp_agent_…cret",
          endpointId: "env_123",
          projectSlug: "demo-app",
          stageSlug: "development",
        }),
      ),
  );

  const key = await client.getRuntimeKey("demo-app", "development");

  expect(key).toEqual({
    apiKey: "fp_agent_secret",
    keyHint: "fp_agent_…cret",
    endpointId: "env_123",
    projectSlug: "demo-app",
    stageSlug: "development",
  });
  expect(calls[0]).toEqual({
    url: "https://convex.example.com/v1/account/projects/demo-app/stages/development/runtime-key",
    method: "GET",
  });
});

test("getRuntimeKey returns null when the stage is unknown", async () => {
  const { client } = clientWith(
    () => new Response("not found", { status: 404 }),
  );

  expect(await client.getRuntimeKey("missing", "development")).toBeNull();
});

test("getEnv GETs the named env var and returns its value", async () => {
  const { client, calls } = clientWith(
    () => new Response(JSON.stringify({ value: "sk-secret" })),
  );

  const value = await client.getEnv(
    "demo-app",
    "development",
    "OPENAI_API_KEY",
  );

  expect(value).toBe("sk-secret");
  expect(calls[0]).toEqual({
    url: "https://convex.example.com/v1/account/projects/demo-app/stages/development/env/OPENAI_API_KEY",
    method: "GET",
  });
});

test("getEnv returns null when the var is not set (404)", async () => {
  const { client } = clientWith(
    () => new Response("not found", { status: 404 }),
  );

  expect(await client.getEnv("demo-app", "development", "MISSING")).toBeNull();
});

test("removeEnv DELETEs the named env var", async () => {
  const { client, calls } = clientWith(
    () => new Response(JSON.stringify({ removed: true })),
  );

  await client.removeEnv("demo-app", "development", "OPENAI_API_KEY");

  expect(calls[0]).toEqual({
    url: "https://convex.example.com/v1/account/projects/demo-app/stages/development/env/OPENAI_API_KEY",
    method: "DELETE",
  });
});

test("removeEnv throws on a non-ok response", async () => {
  const { client } = clientWith(() => new Response("nope", { status: 500 }));

  await expect(
    client.removeEnv("demo-app", "development", "X"),
  ).rejects.toThrow("Remove environment variable failed");
});

// The backend keys the manifest route off the stage segment and rejects a
// manifest body carrying the pre-rename `environment` field.
test("putManifest PUTs to the stage manifest route and sends manifest.stage", async () => {
  const manifest = {
    version: 1 as const,
    project: "demo-app",
    stage: "staging",
    resources: [],
  };
  let sent: { url: string; body: string } | undefined;
  const client = new BroodsSyncClient({
    baseUrl: "https://convex.example.com",
    token: "tok",
    fetch: async (input, init) => {
      sent = { url: String(input), body: String(init?.body ?? "") };

      return new Response(
        JSON.stringify({ manifest: manifest, ids: {}, deployment: null }),
      );
    },
  });

  await client.putManifest(manifest, false);

  expect(sent?.url).toBe(
    "https://convex.example.com/v1/account/projects/demo-app/stages/staging/manifest",
  );
  expect(JSON.parse(sent?.body ?? "{}").manifest).toEqual(manifest);
});
