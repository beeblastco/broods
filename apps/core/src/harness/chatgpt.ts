/**
 * The `chatgpt` model provider's runtime half: OpenAI's Responses API on the
 * account's Sign in with ChatGPT login instead of an API key. This file owns
 * the login's access token (load, refresh, save the rotated pair back) and
 * shapes each request into what plan usage accepts. `provider.ts` builds the
 * model; the CLI does the browser sign-in; the config plane stores it.
 * https://developers.openai.com/siwc/token-sharing-open-source
 */

import type { LanguageModelMiddleware } from "ai";
import {
  CHATGPT_RESOURCE,
  CHATGPT_TOKEN_URL,
} from "@broods/convex/model/chatgpt";
import { getStorage, type ProviderCredential } from "../shared/storage.ts";
import { REFRESH_MARGIN_MS, refreshTokenGrant } from "./mcp/oauth.ts";

/** Re-read the stored login this often, so a new `broods login chatgpt` lands. */
const CACHE_TTL_MS = 5 * 60_000;
/** A stalled refresh fails rather than hold every run waiting on it. */
const REFRESH_TIMEOUT_MS = 15_000;

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

const REAUTHORIZE_HINT = "Run `broods login chatgpt` to sign in again.";

interface CachedCredential {
  credential: ProviderCredential;
  loadedAt: number;
}

/** The slice of a Responses request body this file reads or rewrites. */
interface ResponsesRequestBody {
  stream?: boolean;
  [field: string]: unknown;
}

// Core runs one replica, so an in-flight promise per account is all the
// serialization a rotating refresh token needs: two runs never spend it twice.
const cache = new Map<string, CachedCredential>();
const inFlight = new Map<string, Promise<ProviderCredential>>();

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
 * The `fetch` a `chatgpt` model calls through: stamps the login's current
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
    const credential = await currentCredential(accountId);
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${credential.accessToken}`);
    let body = init?.body;
    let wantsJson = false;
    if (typeof body === "string") {
      const parsed = JSON.parse(body) as ResponsesRequestBody;
      for (const field of UNSUPPORTED_REQUEST_FIELDS) delete parsed[field];
      wantsJson = parsed.stream !== true;
      body = JSON.stringify({ ...parsed, stream: true });
    }
    const response = await modelFetch(input, {
      ...init,
      headers: headers,
      body: body,
    });
    // A revoked or replaced sign-in: the next call re-reads the stored one.
    if (response.status === 401) cache.delete(accountId);

    return wantsJson && response.ok
      ? await completedResponse(response)
      : response;
  };

  return Object.assign(request, { preconnect: fetch.preconnect });
}

/** Forget cached logins; tests only. */
export function resetChatGPTCredentialsForTests(): void {
  cache.clear();
  inFlight.clear();
}

async function currentCredential(
  accountId: string,
): Promise<ProviderCredential> {
  const cached = cache.get(accountId);
  if (
    cached &&
    Date.now() - cached.loadedAt < CACHE_TTL_MS &&
    !expiresSoon(cached.credential)
  ) {
    return cached.credential;
  }
  const pending = inFlight.get(accountId);
  if (pending) return await pending;

  const next = loadFresh(accountId).finally(() => inFlight.delete(accountId));
  inFlight.set(accountId, next);

  return await next;
}

// Always re-read before refreshing: a new sign-in or another refresh may have
// replaced the token pair since it was cached.
async function loadFresh(accountId: string): Promise<ProviderCredential> {
  const stored = await getStorage().providerCredentials.load(
    accountId,
    "chatgpt",
  );
  if (!stored) {
    cache.delete(accountId);
    throw new Error(`This account has no ChatGPT sign-in. ${REAUTHORIZE_HINT}`);
  }
  const credential = expiresSoon(stored)
    ? await refreshAndSave(accountId, stored)
    : stored;
  cache.set(accountId, { credential: credential, loadedAt: Date.now() });

  return credential;
}

async function refreshAndSave(
  accountId: string,
  stored: ProviderCredential,
): Promise<ProviderCredential> {
  // No scope: the refreshed grant keeps exactly what the user approved.
  const refreshed = await refreshTokenGrant(
    CHATGPT_TOKEN_URL,
    {
      client_id: stored.clientId,
      refresh_token: stored.refreshToken,
      resource: CHATGPT_RESOURCE,
    },
    (url, init) =>
      fetch(url, { ...init, signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS) }),
  ).catch((error: unknown) => {
    throw new Error(
      `ChatGPT sign-in refresh failed: ${error instanceof Error ? error.message : String(error)}. ${REAUTHORIZE_HINT}`,
    );
  });
  // The refresh token rotates; keep the old one only if none came back.
  const rotated = {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken ?? stored.refreshToken,
    expiresAt: refreshed.expiresAt,
  };
  const saved = await getStorage().providerCredentials.saveRefreshed(
    accountId,
    "chatgpt",
    stored,
    rotated,
  );
  // A new sign-in or a logout landed while this refresh ran; it wins.
  if (!saved) return await loadFresh(accountId);

  return { ...stored, ...rotated, updatedAt: Date.now() };
}

function expiresSoon(credential: ProviderCredential): boolean {
  return credential.expiresAt - Date.now() < REFRESH_MARGIN_MS;
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
    const event = JSON.parse(data) as {
      type?: string;
      response?: { error?: unknown };
      error?: unknown;
    };
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
