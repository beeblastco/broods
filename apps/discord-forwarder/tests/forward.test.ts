import { afterEach, describe, expect, it, jest, spyOn } from "bun:test";
import { discordForwarderToken } from "../../core/src/shared/discord-wire.ts";
import type { MessageCreate } from "../src/discord.ts";
import {
  fanOut,
  forwardMessageCreate,
  type ForwardTarget,
} from "../src/forward.ts";

const MESSAGE: MessageCreate = {
  id: "message-1",
  channel_id: "channel-1",
  content: "ship it",
  guild_id: "guild-1",
  // No `bot` flag, which is what Discord sends for a human author.
  author: { id: "user-1", username: "ada" },
};

const TARGETS: ForwardTarget[] = [
  {
    agentId: "agent-1",
    agentName: "support",
    webhookUrl: "https://gateway.example.com/v1/webhooks/account-1/discord",
  },
  {
    agentId: "agent-2",
    agentName: "triage",
    webhookUrl:
      "https://gateway.example.com/v1/webhooks/account-1/dev/e1/discord",
  },
];

const realFetch = globalThis.fetch;

interface Capture {
  body: unknown;
  headers: Record<string, string>;
  url: string;
}

function captureFetch(status = 200): Capture[] {
  const calls: Capture[] = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push({
      body: JSON.parse(typeof init?.body === "string" ? init.body : ""),
      headers: (init?.headers ?? {}) as Record<string, string>,
      url: input instanceof Request ? input.url : input.toString(),
    });

    return new Response("", { status: status });
  }) as typeof fetch;

  return calls;
}

afterEach((): void => {
  jest.useRealTimers();
  globalThis.fetch = realFetch;
});

describe("forwarding a gateway message", () => {
  it("posts the payload verbatim under the shape core accepts", async () => {
    const calls = captureFetch();
    await forwardMessageCreate(MESSAGE, null, "token-a", [TARGETS[0]!]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(TARGETS[0]!.webhookUrl);
    expect(calls[0]!.body).toEqual({
      type: "GATEWAY_MESSAGE_CREATE",
      data: MESSAGE,
    });
  });

  it("authenticates with the derived credential, never the bot token", async () => {
    const calls = captureFetch();
    await forwardMessageCreate(MESSAGE, null, "token-a", [TARGETS[0]!]);

    expect(calls[0]!.headers["x-discord-gateway-token"]).toBe(
      discordForwarderToken("token-a"),
    );
    expect(Object.values(calls[0]!.headers)).not.toContain("token-a");
  });

  it("adds the thread object Discord leaves out", async () => {
    const calls = captureFetch();
    await forwardMessageCreate(
      { ...MESSAGE, channel_id: "thread-1" },
      { id: "thread-1", parent_id: "channel-1" },
      "token-a",
      [TARGETS[0]!],
    );

    expect(calls[0]!.body).toMatchObject({
      data: {
        channel_id: "thread-1",
        thread: { id: "thread-1", parent_id: "channel-1" },
      },
    });
  });

  it("fans one event out to every webhook the token serves", async () => {
    const calls = captureFetch();
    await forwardMessageCreate(MESSAGE, null, "token-a", TARGETS);

    expect(calls.map((call) => call.url)).toEqual(
      TARGETS.map((target) => target.webhookUrl),
    );
  });

  it("retries a 5xx and a network error until core answers", async (): Promise<void> => {
    const seen = scriptFetch([503, "reset", 200]);
    await withoutWaiting(
      forwardMessageCreate(MESSAGE, null, "token-a", [TARGETS[0]!]),
    );

    expect(seen.calls).toBe(3);
  });

  it("stops after three attempts", async (): Promise<void> => {
    const seen = scriptFetch([500, 500, 500, 500]);
    await withoutWaiting(
      forwardMessageCreate(MESSAGE, null, "token-a", [TARGETS[0]!]),
    );

    expect(seen.calls).toBe(3);
  });

  it("retries a 408 and a 429 like a 5xx", async (): Promise<void> => {
    const seen = scriptFetch([408, 429, 200]);
    await withoutWaiting(
      forwardMessageCreate(MESSAGE, null, "token-a", [TARGETS[0]!]),
    );

    expect(seen.calls).toBe(3);
  });

  it("waits as long as Retry-After asks instead of the backoff", async (): Promise<void> => {
    const delays: number[] = [];
    const sleep = spyOn(Bun, "sleep").mockImplementation(
      async (ms: number | Date): Promise<void> => {
        delays.push(Number(ms));
      },
    );
    const seen = scriptFetch([
      new Response("", { headers: { "retry-after": "2" }, status: 429 }),
      200,
    ]);
    try {
      await forwardMessageCreate(MESSAGE, null, "token-a", [TARGETS[0]!]);
    } finally {
      sleep.mockRestore();
    }

    expect(seen.calls).toBe(2);
    expect(delays).toEqual([2_000]);
  });

  it("does not retry a 4xx", async (): Promise<void> => {
    const seen = scriptFetch([403]);
    await forwardMessageCreate(MESSAGE, null, "token-a", [TARGETS[0]!]);

    expect(seen.calls).toBe(1);
  });

  // A core that predates the derived credential answers it with a 401 but
  // still accepts the raw bot token. Rollout order is not guaranteed (the one
  // forwarder release serves prod too and promote dispatches the rollouts in
  // parallel), so a message sent into that window must not be dropped.
  it("falls back to the raw bot token when core predates the derived credential", async (): Promise<void> => {
    const derived = discordForwarderToken("token-a");
    const tokens: string[] = [];
    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const token = (init?.headers as Record<string, string>)[
        "x-discord-gateway-token"
      ]!;
      tokens.push(token);

      return new Response("", { status: token === derived ? 401 : 200 });
    }) as typeof fetch;
    await withoutWaiting(
      forwardMessageCreate(MESSAGE, null, "token-a", [TARGETS[0]!]),
    );

    expect(tokens).toEqual([derived, "token-a"]);
  });

  it("still tries the raw token when the 401 lands on the last attempt", async (): Promise<void> => {
    const seen = scriptFetch([503, 503, 401, 200]);
    await withoutWaiting(
      forwardMessageCreate(MESSAGE, null, "token-a", [TARGETS[0]!]),
    );

    expect(seen.calls).toBe(4);
  });

  it("settles a 401 that the raw token does not cure", async (): Promise<void> => {
    const seen = scriptFetch([401, 401]);
    await withoutWaiting(
      forwardMessageCreate(MESSAGE, null, "token-a", [TARGETS[0]!]),
    );

    expect(seen.calls).toBe(2);
  });

  // Matrix awaits each delivery in its sync loop, so it does not opt in.
  it("tries once for a caller that does not ask for more", async (): Promise<void> => {
    const seen = scriptFetch([503]);
    const pending = await fanOut([TARGETS[0]!], "{}", {
      header: "x-token",
      timeoutMs: 1_000,
      token: "token-a",
    });

    expect(seen.calls).toBe(1);
    expect(pending).toEqual([TARGETS[0]!.webhookUrl]);
  });

  // Matrix retries the targets this resolves, so a 4xx must not be one.
  it("resolves only the targets that could still take it", async (): Promise<void> => {
    const auth = { header: "x-token", timeoutMs: 1_000, token: "token-a" };
    const first = [TARGETS[0]!.webhookUrl];

    scriptFetch([200, 404]);
    expect(await fanOut(TARGETS, "{}", auth)).toEqual([]);
    scriptFetch([200, 503]);
    expect(await fanOut(TARGETS, "{}", auth)).toEqual([TARGETS[1]!.webhookUrl]);
    scriptFetch(["reset"]);
    expect(await fanOut([TARGETS[0]!], "{}", auth)).toEqual(first);
    scriptFetch([408]);
    expect(await fanOut([TARGETS[0]!], "{}", auth)).toEqual(first);
    scriptFetch([429]);
    expect(await fanOut([TARGETS[0]!], "{}", auth)).toEqual(first);
  });

  it("resolves a webhook that never answers", async (): Promise<void> => {
    using server = Bun.serve({
      port: 0,
      fetch: (): Promise<Response> => new Promise((): void => {}),
    });
    globalThis.fetch = realFetch;

    expect(
      await fanOut(
        [{ ...TARGETS[0]!, webhookUrl: `http://localhost:${server.port}/` }],
        "{}",
        { header: "x-token", timeoutMs: 50, token: "token-a" },
      ),
    ).toEqual([`http://localhost:${server.port}/`]);
  });
});

/** Answers each POST with the next status or response, or throws for "reset". */
function scriptFetch(statuses: readonly (number | "reset" | Response)[]): {
  calls: number;
} {
  const seen = { calls: 0 };
  globalThis.fetch = (async (): Promise<Response> => {
    const status = statuses[seen.calls] ?? 200;
    seen.calls += 1;
    if (status === "reset") throw new Error("connection reset");
    if (status instanceof Response) return status;

    return new Response("", { status: status });
  }) as unknown as typeof fetch;

  return seen;
}

/** Runs `work` to completion with the retry backoff fast-forwarded. */
async function withoutWaiting(work: Promise<void>): Promise<void> {
  jest.useFakeTimers();
  let done = false;
  void work.finally((): void => {
    done = true;
  });
  for (;;) {
    if (done) break;
    jest.advanceTimersByTime(5_000);
    await Promise.resolve();
  }

  await work;
}
