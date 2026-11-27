import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { chatgptFetch } from "../../../../apps/core/src/harness/chatgpt.ts";
import { resetConnectionsForTests } from "../../../../apps/core/src/harness/connections.ts";
import {
  setStorageForTests,
  type Storage,
} from "../../../../apps/core/src/shared/storage.ts";

const REQUEST_BODY = JSON.stringify({ model: "gpt-5.5", input: [] });
let stream: string;

function modelFetch(): typeof fetch {
  return Object.assign(
    async (): Promise<Response> =>
      new Response(stream, {
        headers: { "Content-Type": "text/event-stream" },
      }),
    { preconnect: fetch.preconnect },
  );
}

function sse(...events: unknown[]): string {
  return events
    .map((event): string => `data: ${JSON.stringify(event)}\n\n`)
    .join("");
}

async function complete(): Promise<Response> {
  return chatgptFetch("account-1", modelFetch())(
    "https://chatgpt.example/responses",
    {
      method: "POST",
      body: REQUEST_BODY,
    },
  );
}

beforeEach((): void => {
  resetConnectionsForTests();
  setStorageForTests({
    connections: {
      load: async (): Promise<object> => ({
        type: "chatgpt",
        scopes: ["chatgpt.tokens.use.direct"],
        accessToken: "access-1",
        refreshToken: "refresh-1",
        clientId: "client-1",
        expiresAt: Date.now() + 3_600_000,
        updatedAt: 1,
      }),
    },
  } as Partial<Storage> as Storage);
});

afterEach((): void => {
  setStorageForTests(null);
});

describe("completedResponse", (): void => {
  test("answers with the completed response, skipping blank, done and broken lines", async (): Promise<void> => {
    stream = `data:\n\ndata: [DONE]\n\ndata: {not json\n\n: comment\n\n${sse({
      type: "response.completed",
      response: { id: "resp_1", status: "completed" },
    })}`;
    const response = await complete();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: "resp_1",
      status: "completed",
    });
  });

  test("answers 400 with the response's error when the stream failed", async (): Promise<void> => {
    stream = sse({
      type: "response.failed",
      response: { error: { message: "boom" } },
    });
    const response = await complete();

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { message: "boom" } });
  });

  test("answers 400 with the stream's own error event", async (): Promise<void> => {
    stream = sse({ type: "error", error: { message: "bad" } });
    const response = await complete();

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { message: "bad" } });
  });

  test("answers 502 when the stream ends before it completed", async (): Promise<void> => {
    stream = sse({ type: "response.created", response: {} });
    const response = await complete();

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: { message: "ChatGPT stream ended before response.completed" },
    });
  });
});
