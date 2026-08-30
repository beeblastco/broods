/**
 * Agent lifecycle webhook emitter tests.
 * Cover event filtering, delivery, error handling, and value serialization.
 *
 * Delivery runs against a real TLS server on loopback rather than a stubbed
 * `fetch`, because `fireWebhook` connects through the pinned guard: it resolves
 * the name itself and opens the socket to the address it validated, so there is
 * no global for a stub to replace.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { createServer as createHttpsServer, type Server } from "node:https";
import type { PinnedFetchTransport } from "../src/shared/http.ts";
import {
  createAgentLifecycleEmitter,
  toLifecycleValue,
} from "../src/harness/lifecycle.ts";
import { fireWebhook } from "../src/shared/webhook.ts";

// The same self-signed pair the attachment tests use, minted for `public.test`.
const TLS_CERT = readFileSync(
  new URL("./helpers/fixtures/attachment-tls-cert.pem", import.meta.url),
  "utf8",
);
const TLS_KEY = readFileSync(
  new URL("./helpers/fixtures/attachment-tls-key.pem", import.meta.url),
  "utf8",
);

interface Delivery {
  body: string;
  path: string;
  signature: string | undefined;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("createAgentLifecycleEmitter", () => {
  const baseSession = {
    accountId: "acct_test",
    agentId: "agent_test",
    eventId: "evt_123",
    conversationKey: "direct:conv_1",
  };

  it("does not fire when webhook is not enabled", async () => {
    const fetchMock = mock(async () => new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock as never;

    const emitter = createAgentLifecycleEmitter(baseSession, {
      hooks: {
        webhooks: [
          {
            enabled: false,
            url: "https://example.com/hook",
            secret: "secret",
          },
        ],
      },
    });

    await emitter.emit("agent.started", { modelProvider: "google" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fire when webhook url is missing", async () => {
    const fetchMock = mock(async () => new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock as never;

    const emitter = createAgentLifecycleEmitter(baseSession, {
      hooks: {
        webhooks: [
          {
            enabled: true,
            secret: "secret",
          },
        ],
      },
    });

    await emitter.emit("agent.started", { modelProvider: "google" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fire when webhook secret is missing", async () => {
    const fetchMock = mock(async () => new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock as never;

    const emitter = createAgentLifecycleEmitter(baseSession, {
      hooks: {
        webhooks: [
          {
            enabled: true,
            url: "https://example.com/hook",
          },
        ],
      },
    });

    await emitter.emit("agent.started", { modelProvider: "google" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fire when no webhooks are configured", async () => {
    const fetchMock = mock(async () => new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock as never;

    const emitter = createAgentLifecycleEmitter(baseSession, {
      hooks: { webhooks: [] },
    });

    await emitter.emit("agent.started", {});

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fire when event is not in subscribed events allow-list", async () => {
    const fetchMock = mock(async () => new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock as never;

    const emitter = createAgentLifecycleEmitter(baseSession, {
      hooks: {
        webhooks: [
          {
            enabled: true,
            url: "https://example.com/hook",
            secret: "secret",
            events: ["agent.finished"],
          },
        ],
      },
    });

    await emitter.emit("agent.started", { modelProvider: "google" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fires webhook for subscribed events", async () => {
    await withWebhookServer(async (url, deliveries) => {
      const emitter = createAgentLifecycleEmitter(
        baseSession,
        {
          hooks: {
            webhooks: [
              {
                enabled: true,
                url: url("/hook"),
                secret: "secret",
                events: ["agent.started", "agent.finished"],
              },
            ],
          },
        },
        transport(),
      );

      await emitter.emit("agent.started", {
        modelProvider: "google",
        modelId: "gemini-2.0",
      });

      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]!.path).toBe("/hook");
      expect(deliveries[0]!.signature).toMatch(/^sha256=[0-9a-f]{64}$/);
      expect(JSON.parse(deliveries[0]!.body)).toMatchObject({
        type: "agent.started",
        accountId: "acct_test",
        agentId: "agent_test",
        eventId: "evt_123",
        conversationKey: "direct:conv_1",
        payload: { modelProvider: "google", modelId: "gemini-2.0" },
      });
    });
  });

  it("fires every matching webhook when several are registered", async () => {
    await withWebhookServer(async (url, deliveries) => {
      const emitter = createAgentLifecycleEmitter(
        baseSession,
        {
          hooks: {
            webhooks: [
              {
                enabled: true,
                url: url("/a"),
                secret: "s1",
                events: ["agent.started"],
              },
              { enabled: true, url: url("/b"), secret: "s2" },
              { enabled: false, url: url("/c"), secret: "s3" },
              {
                enabled: true,
                url: url("/d"),
                secret: "s4",
                events: ["agent.finished"],
              },
            ],
          },
        },
        transport(),
      );

      await emitter.emit("agent.started", {});

      // a (subscribed) and b (no allow-list) fire; c is disabled; d only wants
      // agent.finished.
      expect(deliveries.map((d) => d.path).sort()).toEqual(["/a", "/b"]);
    });
  });

  it("fires all events when no events allow-list is configured", async () => {
    await withWebhookServer(async (url, deliveries) => {
      const emitter = createAgentLifecycleEmitter(
        baseSession,
        {
          hooks: {
            webhooks: [{ enabled: true, url: url("/hook"), secret: "secret" }],
          },
        },
        transport(),
      );

      await emitter.emit("tool.call.started", { stepNumber: 1 });
      await emitter.emit("agent.finished", { finishReason: "stop" });

      expect(deliveries).toHaveLength(2);
    });
  });

  it("swallows a delivery failure so the run continues", async () => {
    await withWebhookServer(
      async (url, deliveries) => {
        const emitter = createAgentLifecycleEmitter(
          baseSession,
          {
            hooks: {
              webhooks: [
                { enabled: true, url: url("/hook"), secret: "secret" },
              ],
            },
          },
          transport(),
        );

        // A rejected delivery must not propagate out of emit.
        await emitter.emit("agent.failed", { error: "something broke" });

        expect(deliveries).toHaveLength(1);
      },
      { status: 500 },
    );
  });

  it("includes accountId and agentId only when present in session", async () => {
    await withWebhookServer(async (url, deliveries) => {
      const emitter = createAgentLifecycleEmitter(
        { eventId: "evt_456", conversationKey: "direct:conv_2" } as never,
        {
          hooks: {
            webhooks: [{ enabled: true, url: url("/hook"), secret: "secret" }],
          },
        },
        transport(),
      );

      await emitter.emit("agent.started", {});

      const body = JSON.parse(deliveries[0]!.body);
      expect(body).not.toHaveProperty("accountId");
      expect(body).not.toHaveProperty("agentId");
      expect(body.eventId).toBe("evt_456");
      expect(body.conversationKey).toBe("direct:conv_2");
    });
  });

  it("refuses a webhook whose name resolves to a private address", async () => {
    // The name is public and passes the protocol check; only resolution reveals
    // the metadata address. A hostname string check cannot see this, which is
    // the whole reason delivery goes through the pinned guard.
    await expect(
      fireWebhook(
        { url: "https://public.test/hook", secret: "secret" },
        { type: "agent.started" },
        {
          lookup: async (): Promise<{ address: string; family: number }[]> => [
            { address: "169.254.169.254", family: 4 },
          ],
        },
      ),
    ).rejects.toThrow(/blocked private or metadata address/);
  });

  it("generates ISO timestamp for each event", async () => {
    await withWebhookServer(async (url, deliveries) => {
      const emitter = createAgentLifecycleEmitter(
        baseSession,
        {
          hooks: {
            webhooks: [{ enabled: true, url: url("/hook"), secret: "secret" }],
          },
        },
        transport(),
      );

      await emitter.emit("agent.started", {});

      expect(JSON.parse(deliveries[0]!.body).timestamp).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/,
      );
    });
  });
});

describe("toLifecycleValue", () => {
  it("returns undefined for undefined input", () => {
    expect(toLifecycleValue(undefined)).toBeUndefined();
  });

  it("serializes and parses plain objects", () => {
    const input = { success: true, count: 42 };
    expect(toLifecycleValue(input)).toEqual({ success: true, count: 42 });
  });

  it("serializes and parses arrays", () => {
    const input = ["a", "b", "c"];
    expect(toLifecycleValue(input)).toEqual(["a", "b", "c"]);
  });

  it("serializes and parses primitives", () => {
    expect(toLifecycleValue(42)).toBe(42);
    expect(toLifecycleValue("hello")).toBe("hello");
    expect(toLifecycleValue(true)).toBe(true);
    expect(toLifecycleValue(null)).toBeNull();
  });

  it("returns stringified fallback for non-serializable values", () => {
    const result = toLifecycleValue(() => {});
    expect(typeof result).toBe("string");
  });

  it("handles BigInt by falling back to string", () => {
    const result = toLifecycleValue(BigInt(9007199254740991));
    expect(typeof result).toBe("string");
    expect(result).toBe("9007199254740991");
  });
});

// Only loopback is exempted; every other address still meets the real denylist,
// so these tests exercise the same guard production runs.
function transport(): PinnedFetchTransport {
  return {
    allowAddresses: ["127.0.0.1"],
    ca: TLS_CERT,
    lookup: async (
      hostname: string,
    ): Promise<{ address: string; family: number }[]> => {
      if (hostname !== "public.test") {
        throw new Error(`no test DNS entry for ${hostname}`);
      }

      return [{ address: "127.0.0.1", family: 4 }];
    },
  };
}

async function withWebhookServer(
  run: (url: (path: string) => string, deliveries: Delivery[]) => Promise<void>,
  options: { status?: number } = {},
): Promise<void> {
  const deliveries: Delivery[] = [];
  const server: Server = createHttpsServer(
    { cert: TLS_CERT, key: TLS_KEY },
    (request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        deliveries.push({
          body: Buffer.concat(chunks).toString("utf8"),
          path: request.url ?? "",
          signature: request.headers["x-webhook-signature"] as
            | string
            | undefined,
        });
        response.writeHead(options.status ?? 200);
        response.end();
      });
    },
  );

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address !== "object") {
    throw new Error("test server has no port");
  }
  try {
    await run(
      (path) => `https://public.test:${address.port}${path}`,
      deliveries,
    );
  } finally {
    server.close();
  }
}
