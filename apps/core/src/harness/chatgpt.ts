// Sign in with ChatGPT: https://developers.openai.com/siwc/token-sharing-open-source

import type { LanguageModelMiddleware } from "ai";
import { connectionFetch } from "./connections.ts";

// Plan usage refuses these; dropped so one agent config runs on `openai` and `chatgpt` alike.
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

interface ResponsesRequestBody {
  stream?: boolean;
  [field: string]: unknown;
}

interface ResponsesStreamEvent {
  type?: string;
  response?: { error?: unknown };
  error?: unknown;
}

// `store: false` also makes the AI SDK replay history as content, not unresolvable item refs.
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

/** Plan usage always streams; a non-streaming SDK call is read to the end and answered as JSON. */
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
      modelFetch,
    )(input, { ...init, body: body });

    return wantsJson && response.ok
      ? await completedResponse(response)
      : response;
  };

  return Object.assign(request, { preconnect: fetch.preconnect });
}

async function completedResponse(response: Response): Promise<Response> {
  const text = await response.text();
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice("data:".length).trim();
    if (!data || data === "[DONE]") continue;
    let event: ResponsesStreamEvent;
    try {
      event = JSON.parse(data) as ResponsesStreamEvent;
    } catch {
      continue;
    }
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
