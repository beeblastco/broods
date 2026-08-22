import { afterEach, describe, expect, it } from "bun:test";
import { ThreadDirectory } from "../src/threads.ts";

const realFetch = globalThis.fetch;

function stubChannel(body: unknown, status = 200): { requests: string[] } {
  const requests: string[] = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
  ): Promise<Response> => {
    requests.push(String(input));

    return status === 200
      ? Response.json(body)
      : new Response("", { status: status });
  }) as typeof fetch;

  return { requests: requests };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("thread directory", () => {
  it("reports the parent of a thread channel", async () => {
    stubChannel({ id: "thread-1", type: 11, parent_id: "channel-1" });
    const directory = new ThreadDirectory("token-a");

    expect(await directory.resolve("thread-1")).toEqual({
      id: "thread-1",
      parent_id: "channel-1",
    });
  });

  it("reports nothing for an ordinary text channel", async () => {
    stubChannel({ id: "channel-1", type: 0 });
    const directory = new ThreadDirectory("token-a");

    expect(await directory.resolve("channel-1")).toBeNull();
  });

  it("looks a channel up once", async () => {
    const stub = stubChannel({ id: "channel-1", type: 0 });
    const directory = new ThreadDirectory("token-a");
    await directory.resolve("channel-1");
    await directory.resolve("channel-1");

    expect(stub.requests).toHaveLength(1);
  });

  it("does not cache a failed lookup, so a rate limit self-heals", async () => {
    const stub = stubChannel(null, 429);
    const directory = new ThreadDirectory("token-a");

    expect(await directory.resolve("channel-1")).toBeNull();
    await directory.resolve("channel-1");
    expect(stub.requests).toHaveLength(2);
  });

  it("asks Discord for the channel by id", async () => {
    const stub = stubChannel({ id: "channel-1", type: 0 });
    await new ThreadDirectory("token-a").resolve("channel-1");

    expect(stub.requests).toEqual([
      "https://discord.com/api/v10/channels/channel-1",
    ]);
  });

  it("reports nothing for a thread type that names no parent", async () => {
    stubChannel({ id: "thread-1", type: 11 });
    const directory = new ThreadDirectory("token-a");

    expect(await directory.resolve("thread-1")).toBeNull();
  });

  it("shares one request across a burst on the same channel", async () => {
    const stub = stubChannel({ id: "thread-1", type: 11, parent_id: "c-1" });
    const directory = new ThreadDirectory("token-a");

    const resolved = await Promise.all([
      directory.resolve("thread-1"),
      directory.resolve("thread-1"),
      directory.resolve("thread-1"),
    ]);

    expect(stub.requests).toHaveLength(1);
    expect(resolved).toEqual([
      { id: "thread-1", parent_id: "c-1" },
      { id: "thread-1", parent_id: "c-1" },
      { id: "thread-1", parent_id: "c-1" },
    ]);
  });
});
