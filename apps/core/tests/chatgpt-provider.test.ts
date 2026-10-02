/**
 * The `chatgpt` provider against a stubbed OpenAI: the sign-in's token rides
 * every request, plan usage only ever sees a stored-nothing stream, and a
 * rotated refresh token is saved back exactly once.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { generateText, streamText } from "ai";
import { resetChatGPTCredentialsForTests } from "../src/harness/chatgpt.ts";
import { resolveConfiguredModel } from "../src/harness/provider.ts";
import {
  setStorageForTests,
  type ProviderCredential,
  type Storage,
} from "../src/shared/storage.ts";

const ACCOUNT_ID = "account-1";

const completed = {
  id: "resp_1",
  object: "response",
  created_at: 0,
  status: "completed",
  model: "gpt-5.5",
  output: [
    {
      type: "message",
      id: "msg_1",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "hi", annotations: [] }],
    },
  ],
  usage: {
    input_tokens: 3,
    output_tokens: 1,
    total_tokens: 4,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  },
};

const responseEvents = [
  {
    type: "response.created",
    response: { ...completed, status: "in_progress", output: [] },
  },
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "message", id: "msg_1", role: "assistant", content: [] },
  },
  {
    type: "response.output_text.delta",
    item_id: "msg_1",
    output_index: 0,
    content_index: 0,
    delta: "hi",
  },
  {
    type: "response.output_item.done",
    output_index: 0,
    item: completed.output[0],
  },
  { type: "response.completed", response: completed },
];

interface SentRequest {
  url: string;
  headers: Headers;
  body: string;
}

let sent: SentRequest[];
let saved: Array<Parameters<Storage["providerCredentials"]["saveRefreshed"]>>;
let stored: ProviderCredential | null;
let tokenResponse: Response;
const realFetch = globalThis.fetch;

beforeEach(() => {
  sent = [];
  saved = [];
  stored = credential({ expiresAt: Date.now() + 3_600_000 });
  tokenResponse = Response.json({
    access_token: "access-2",
    refresh_token: "refresh-2",
    expires_in: 600,
    scope: "openid chatgpt.tokens.use.direct",
  });
  resetChatGPTCredentialsForTests();
  setStorageForTests({
    providerCredentials: {
      load: async () => stored,
      saveRefreshed: async (...args) => {
        saved.push(args);

        return true;
      },
    },
  } as Partial<Storage> as Storage);
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      sent.push({
        url: url,
        headers: new Headers(init?.headers),
        body:
          init?.body instanceof URLSearchParams
            ? init.body.toString()
            : typeof init?.body === "string"
              ? init.body
              : "",
      });
      if (url.startsWith("https://auth.openai.com/")) return tokenResponse;

      return new Response(
        responseEvents
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
    { preconnect: realFetch.preconnect },
  );
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setStorageForTests(null);
});

describe("chatgpt provider", () => {
  it("streams on the sign-in's token with nothing plan usage refuses", async () => {
    // Not a reasoning model, so the SDK itself sends temperature and system.
    const { model } = resolveConfiguredModel(
      { model: { provider: "chatgpt", modelId: "gpt-4.1-mini" } },
      ACCOUNT_ID,
    );

    const result = streamText({
      model: model,
      system: "be brief",
      prompt: "hello",
      temperature: 0.2,
      maxOutputTokens: 100,
    });

    expect(await result.text).toBe("hi");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("https://api.openai.com/v1/responses");
    expect(sent[0]?.headers.get("authorization")).toBe("Bearer access-1");
    const body = JSON.parse(sent[0]?.body ?? "{}");
    expect(body).toMatchObject({
      model: "gpt-4.1-mini",
      store: false,
      stream: true,
    });
    expect(body.temperature).toBeUndefined();
    expect(body.max_output_tokens).toBeUndefined();
    expect(body.input[0]).toMatchObject({ role: "developer" });
  });

  it("answers a non-streaming call from the completed stream", async () => {
    const { model } = chatgptModel();

    const result = await generateText({ model: model, prompt: "hello" });

    expect(result.text).toBe("hi");
    expect(JSON.parse(sent[0]?.body ?? "{}").stream).toBe(true);
  });

  it("answers a non-streaming call from an incomplete stream", async () => {
    const incomplete = { ...completed, status: "incomplete" };
    responseEvents.splice(-1, 1, {
      type: "response.incomplete",
      response: incomplete,
    });
    const { model } = chatgptModel();

    const result = await generateText({
      model: model,
      prompt: "hello",
    }).finally(() =>
      responseEvents.splice(-1, 1, {
        type: "response.completed",
        response: completed,
      }),
    );

    expect(result.text).toBe("hi");
    expect(sent).toHaveLength(1);
  });

  it("refreshes an expiring token once and saves the rotated pair", async () => {
    stored = credential({ expiresAt: Date.now() + 10_000 });
    const { model } = chatgptModel();

    await Promise.all([
      generateText({ model: model, prompt: "one" }),
      generateText({ model: model, prompt: "two" }),
    ]);

    const refreshes = sent.filter((request) =>
      request.url.startsWith("https://auth.openai.com/"),
    );
    expect(refreshes).toHaveLength(1);
    const form = new URLSearchParams(refreshes[0]?.body);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("client_id")).toBe("client-1");
    expect(form.get("refresh_token")).toBe("refresh-1");
    expect(form.get("resource")).toBe("https://api.openai.com/v1");
    expect(saved).toHaveLength(1);
    expect(saved[0]?.[3]).toMatchObject({
      accessToken: "access-2",
      refreshToken: "refresh-2",
    });
    const inference = sent.filter((request) =>
      request.url.endsWith("/responses"),
    );
    expect(
      inference.map((request) => request.headers.get("authorization")),
    ).toEqual(["Bearer access-2", "Bearer access-2"]);
  });

  it("asks for a new sign-in when the refresh token is spent", async () => {
    stored = credential({ expiresAt: Date.now() });
    tokenResponse = Response.json({ error: "invalid_grant" }, { status: 400 });
    const { model } = chatgptModel();

    const error = await generateText({
      model: model,
      prompt: "hello",
      maxRetries: 0,
    }).catch((caught: unknown) => caught);

    expect(String(error)).toContain("invalid_grant");
    expect(String(error)).toContain("broods login chatgpt");
    expect(saved).toHaveLength(0);
  });

  it("asks for a sign-in when the account has none", async () => {
    stored = null;
    const { model } = chatgptModel();

    const error = await generateText({
      model: model,
      prompt: "hello",
      maxRetries: 0,
    }).catch((caught: unknown) => caught);

    expect(String(error)).toContain("no ChatGPT sign-in");
  });
});

function chatgptModel(): ReturnType<typeof resolveConfiguredModel> {
  return resolveConfiguredModel(
    { model: { provider: "chatgpt", modelId: "gpt-5.5" } },
    ACCOUNT_ID,
  );
}

function credential(
  overrides: Partial<ProviderCredential>,
): ProviderCredential {
  return {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    clientId: "client-1",
    expiresAt: Date.now() + 3_600_000,
    updatedAt: 1,
    ...overrides,
  };
}
