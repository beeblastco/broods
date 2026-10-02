/**
 * The `chatgpt` model provider's runtime half: OpenAI's Responses API on the
 * account's `chatgpt` connection (Sign in with ChatGPT) instead of an API
 * key. This file shapes each request into what plan usage accepts;
 * `connections.ts` owns the access token and `provider.ts` builds the model.
 * https://developers.openai.com/siwc/token-sharing-open-source
 */

import type { LanguageModelMiddleware } from "ai";
import { connectionFetch } from "./connections.ts";

// Request fields plan usage refuses outright: the AI SDK sends some of them
// from ordinary call settings (`temperature`, `maxOutputTokens`) and the rest
// from provider options. Dropped rather than failed, so one agent config runs
// on `openai` and `chatgpt` alike.
const UNSUPPORTED_REQUEST_FIELDS = [
  "background",
  "conversation",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "moderation",
  "multi_agent",
  "previous_response_id",
  "prompt",
  "prompt_cache_retention",
  "safety_identifier",
  "temperature",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
] as const;

/** The slice of a Responses request body this file reads or rewrites. */
interface ResponsesRequestBody {
  stream?: boolean;
  [field: string]: unknown;
}

/** The slice of a Responses stream event a non-streaming answer reads. */
interface ResponsesStreamEvent {
  type?: string;
  response?: { error?: unknown };
  error?: unknown;
}

/**
 * Plan usage stores nothing and answers system messages only as developer
 * messages. Turning `store` off is also what makes the AI SDK replay history
 * as content and ask for encrypted reasoning, instead of sending item
 * references this endpoint cannot resolve.
 */
export const chatgptMiddleware: LanguageModelMiddleware = {
  transformParams: async ({ params }) => ({
    ...params,
    providerOptions: {
      ...params.providerOptions,
      openai: {
        ...params.providerOptions?.openai,
        store: false,
        systemMessageMode: "developer",
      },
    },
  }),
};

/**
 * The `fetch` a `chatgpt` model calls through: stamps the connection's current
 * access token, drops what plan usage refuses, and always streams. A call the
 * SDK made without streaming (compaction's `generateText`) is read to
 * `response.completed` and answered as the plain JSON response it expected.
 */
export function chatgptFetch(
  accountId: string | undefined,
  modelFetch: typeof fetch,
): typeof fetch {
  const request = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    if (!accountId) {
      throw new Error("The chatgpt provider runs only inside an account");
    }
    let body = init?.body;
    let wantsJson = false;
    if (typeof body === "string") {
      const parsed = JSON.parse(body) as ResponsesRequestBody;
      for (const field of UNSUPPORTED_REQUEST_FIELDS) delete parsed[field];
      wantsJson = parsed.stream !== true;
      body = JSON.stringify({ ...parsed, stream: true });
    }
    const response = await connectionFetch(
      accountId,
      "chatgpt",
      "model",
      modelFetch,
    )(input, { ...init, body: body });

    return wantsJson && response.ok
      ? await completedResponse(response)
      : response;
  };

  return Object.assign(request, { preconnect: fetch.preconnect });
}

/**
 * Reads a Responses event stream to its end and answers what the
 * non-streaming endpoint would have: the completed (or incomplete) response, or the
 * failure as a 400 the SDK reports with OpenAI's own message.
 */
async function completedResponse(response: Response): Promise<Response> {
  const text = await response.text();
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice("data:".length).trim();
    if (!data || data === "[DONE]") continue;
    let event: ResponsesStreamEvent;
    // A malformed line is skipped; the terminal event decides the answer.
    try {
      event = JSON.parse(data) as ResponsesStreamEvent;
    } catch {
      continue;
    }
    // An incomplete response is still an answer; the SDK reads its status.
    if (
      event.type === "response.completed" ||
      event.type === "response.incomplete"
    ) {
      return Response.json(event.response);
    }
    if (event.type === "response.failed" || event.type === "error") {
      return Response.json(
        { error: event.response?.error ?? event.error },
        { status: 400 },
      );
    }
  }

  return Response.json(
    { error: { message: "ChatGPT stream ended before response.completed" } },
    { status: 502 },
  );
}
