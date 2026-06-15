import { afterEach, expect, test } from "bun:test";
import { DEFAULT_CORE_BASE_URL, FilthyPantyClient } from "../src/client.ts";

afterEach(() => {
  delete process.env.FILTHY_PANTY_BASE_URL;
  delete process.env.FILTHY_PANTY_HOST;
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

test("client starts async runs and exposes status id for polling", async () => {
  const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
  const client = new FilthyPantyClient({
    baseUrl: "https://core.example",
    apiKey: "runtime-key",
    fetch: async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });

      if (String(input).endsWith("/async")) {
        expect(init?.headers).toMatchObject({ Authorization: "Bearer runtime-key" });
        return Response.json({
          statusUrl: "https://core.example/status/request-1?agentId=agent_1",
        }, { status: 202 });
      }

      return Response.json({ status: "completed", response: "done" });
    },
  });

  const run = await client.runAsync({
    agentId: "agent_1",
    eventId: "request-1",
    conversationKey: "conversation-1",
    input: "hello",
  });
  const status = await run.poll();

  expect(run.statusId).toBe("request-1");
  expect(run.eventId).toBe("request-1");
  expect(run.agentId).toBe("agent_1");
  expect(status).toEqual({ status: "completed", response: "done" });
  expect(calls.map((call) => call.url)).toEqual([
    "https://core.example/async",
    "https://core.example/status/request-1?agentId=agent_1",
  ]);
  expect(calls[0]?.body).toMatchObject({
    agentId: "agent_1",
    eventId: "request-1",
    conversationKey: "conversation-1",
  });
});

test("client defaults async conversation key to the generated event id", async () => {
  const bodies: unknown[] = [];
  const client = new FilthyPantyClient({
    baseUrl: "https://core.example",
    apiKey: "runtime-key",
    fetch: async (_input, init) => {
      bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
      return Response.json({
        statusUrl: "https://core.example/status/async-123?agentId=agent_1",
      }, { status: 202 });
    },
  });

  await client.runAsync({
    agentId: "agent_1",
    eventId: "async-123",
    input: "hello",
  });

  expect(bodies[0]).toMatchObject({
    eventId: "async-123",
    conversationKey: "async-123",
  });
});

test("client rejects misrouted async SSE responses without dumping stream internals", async () => {
  const client = new FilthyPantyClient({
    baseUrl: "https://core.example",
    apiKey: "runtime-key",
    fetch: async () =>
      new Response(
        [
          'data: {"type":"start-step","request":{"body":{"contents":[{"role":"user","parts":[{"text":"secret conversation"}]}]}}}',
          "",
          'data: {"type":"reasoning-delta","text":"private model work"}',
          "",
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      ),
  });

  await expect(client.runAsync({
    agentId: "agent_1",
    input: "hello",
  })).rejects.toThrow("server returned an SSE stream");
  await expect(client.runAsync({
    agentId: "agent_1",
    input: "hello",
  })).rejects.not.toThrow("secret conversation");
});

test("client polls async status by status id when agentId is provided", async () => {
  const urls: string[] = [];
  const client = new FilthyPantyClient({
    baseUrl: "https://core.example",
    apiKey: "runtime-key",
    fetch: async (input) => {
      urls.push(String(input));
      return Response.json({ status: "completed", response: { ok: true } });
    },
  });

  const status = await client.getAsyncStatus("request-1", { agentId: "agent_1" });

  expect(status).toEqual({ status: "completed", response: { ok: true } });
  expect(urls).toEqual(["https://core.example/status/request-1?agentId=agent_1"]);
});

test("client creates cron jobs using agent references", async () => {
  const requests: Array<{ url: string; body?: unknown }> = [];
  const client = new FilthyPantyClient({
    baseUrl: "https://core.example",
    apiKey: "runtime-key",
    fetch: async (input, init) => {
      expect(init?.headers).toMatchObject({ Authorization: "Bearer runtime-key" });
      requests.push({
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });

      return Response.json({
        accountId: "acct_1",
        cronJobId: "cron_1",
        name: "daily",
        agentId: "agent_1",
        prompt: "run",
        scheduleExpression: "rate(1 day)",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }, { status: 201 });
    },
  });

  const cronJob = await client.createCronJob({
    name: "daily",
    agent: {
      kind: "agent",
      name: "support",
      id: "agent_1",
      project: "app",
      environment: "development",
    },
    prompt: "run",
    scheduleExpression: "rate(1 day)",
  });

  expect(cronJob.cronJobId).toBe("cron_1");
  expect(requests).toEqual([{
    url: "https://core.example/accounts/me/cron-jobs",
    body: {
      name: "daily",
      agentId: "agent_1",
      prompt: "run",
      scheduleExpression: "rate(1 day)",
    },
  }]);
});
