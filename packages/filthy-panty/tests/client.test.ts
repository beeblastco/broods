import { afterEach, expect, test } from "bun:test";
import { DEFAULT_CORE_BASE_URL, FilthyPantyClient } from "../src/client.ts";

afterEach(() => {
  delete process.env.FILTHY_PANTY_BASE_URL;
  delete process.env.FILTHY_PANTY_HOST;
  delete process.env.FILTHY_PANTY_AGENT_SERVICE_URL;
  delete process.env.FILTHY_PANTY_HARNESS_URL;
  delete process.env.AGENT_SERVICE_URL;
  delete process.env.FILTHY_PANTY_API_KEY;
});

test("client streams directly from core with apiKey auth", async () => {
  const urls: string[] = [];
  const client = new FilthyPantyClient({
    apiKey: "test-key",
    fetch: async (input, init) => {
      urls.push(String(input));
      expect(init?.headers).toMatchObject({
        Accept: "text/event-stream",
        Authorization: "Bearer test-key",
      });

      return new Response([
        'data: {"type":"text-start","id":"0"}',
        'data: {"type":"text-delta","id":"0","text":"hi"}',
        'data: {"type":"text-end","id":"0"}',
        'data: {"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":0,"outputTokens":0,"totalTokens":0}}',
        "",
      ].join("\n\n"));
    },
  });

  const result = await client.run({
    agentId: "agent_1",
    input: "hello",
  });

  expect(urls).toEqual([DEFAULT_CORE_BASE_URL]);
  expect(result.text).toBe("hi");
});

test("client accepts host as a shorthand for https baseUrl", async () => {
  const urls: string[] = [];
  const client = new FilthyPantyClient({
    host: "core.example",
    apiKey: "test-key",
    fetch: async (input) => {
      urls.push(String(input));

      return new Response('data: {"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":0,"outputTokens":0,"totalTokens":0}}\n\n');
    },
  });

  await client.run({
    agentId: "agent_1",
    input: "hello",
  });

  expect(urls).toEqual(["https://core.example"]);
});

test("client reads apiKey from the shared SDK environment variable", async () => {
  process.env.FILTHY_PANTY_API_KEY = "env-key";
  const headers: HeadersInit[] = [];
  const client = new FilthyPantyClient({
    fetch: async (_input, init) => {
      headers.push(init?.headers ?? {});

      return new Response('data: {"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":0,"outputTokens":0,"totalTokens":0}}\n\n');
    },
  });

  await client.run({
    agentId: "agent_1",
    input: "hello",
  });

  expect(headers[0]).toMatchObject({
    Authorization: "Bearer env-key",
  });
});
