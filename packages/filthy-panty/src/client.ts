/**
 * Configurable client for running deployed agents over direct core SSE.
 * Stream chunks are the Vercel AI SDK's `TextStreamPart` parts that core emits.
 */

import type { ModelMessage, TextStreamPart, ToolSet } from "ai";
import { loadFilthyPantyRuntimeConfig } from "./runtime-config.ts";
import { stripTrailingSlash } from "./config.ts";

export const DEFAULT_CORE_BASE_URL = "https://app.beeblast.co";

/**
 * Input for a single agent run. The core direct API is event-based (a list of
 * Vercel AI SDK model messages), so `events` is the full-fidelity form — use it
 * for multimodal content (images/files), ephemeral system messages, or
 * tool-approval responses. `input` is a shorthand for a single user text message
 * and is wrapped into one user event. Provide exactly one of the two.
 */
type AgentRunInputBase = {
  conversationKey?: string;
  eventId?: string;
};

export type AgentRunInput = AgentRunInputBase & ({
  /** Shorthand for a single user text message. */
  input: string;
  events?: never;
} | {
  /** Full-fidelity event list for multimodal content or tool responses. */
  events: [ModelMessage, ...ModelMessage[]];
  input?: never;
});

export interface AgentRunResult {
  text: string;
  events: TextStreamPart<ToolSet>[];
}

export interface AgentReference<Name extends string = string> {
  readonly kind: "agent";
  readonly name: Name;
  readonly id: string;
  readonly project: string;
  readonly environment: string;
  /**
   * Authoritative scope of the environment's runtime key, embedded by codegen
   * from the deploy response. When present the client posts to the scoped URL
   * `/v1/{projectSlug}/agents/{environmentSlug}/{endpointId}` (matching the
   * dashboard); when absent it falls back to the base URL.
   */
  readonly endpointId?: string;
  readonly projectSlug?: string;
  readonly environmentSlug?: string;
}

export interface ResourceApi {
  readonly agents: Record<string, AgentReference>;
  readonly workspaces?: Record<string, unknown>;
  readonly sandboxes?: Record<string, unknown>;
  readonly cronJobs?: Record<string, unknown>;
  readonly skills?: Record<string, unknown>;
  readonly tools?: Record<string, unknown>;
}

export interface FilthyPantyClientOptions {
  /**
   * Base URL of the core service to call directly. Use `https://app.beeblast.co`
   * for the hosted service. If you only have a domain, use `host` instead.
   */
  baseUrl?: string;
  /** Hostname or URL of the core service. `app.beeblast.co` becomes `https://app.beeblast.co`. */
  host?: string;
  /** API key used as the Bearer token for direct runtime calls. */
  apiKey?: string;
  fetch?: typeof fetch;
}

export type AgentHandle = {
  id: string;
  run: (input: AgentRunInput) => Promise<AgentRunResult>;
  stream: (input: AgentRunInput) => AsyncGenerator<TextStreamPart<ToolSet>>;
};

export class FilthyPantyClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: FilthyPantyClientOptions = {}) {
    // Loads package-local .env/.env.local files for Node/Bun callers. Dashboard
    // auth from the returned object is intentionally ignored for runtime calls.
    loadFilthyPantyRuntimeConfig();
    this.baseUrl = normalizeHttpServiceUrl(options.baseUrl ||
      options.host ||
      process.env.FILTHY_PANTY_BASE_URL ||
      process.env.FILTHY_PANTY_HOST ||
      DEFAULT_CORE_BASE_URL);
    this.apiKey = options.apiKey ||
      process.env.FILTHY_PANTY_API_KEY ||
      undefined;
    this.fetchImpl = options.fetch ?? fetch;
  }

  agent<const Name extends string>(ref: AgentReference<Name>): AgentHandle;
  agent(name: string, agentId: string): AgentHandle;
  agent(refOrName: AgentReference | string, agentId?: string): AgentHandle {
    if (typeof refOrName === "string") {
      const name = refOrName;
      const id = agentId ?? "";
      if (!id) throw new Error(`Agent ${name} is missing a generated id. Run filthy-panty deploy first.`);

      return {
        id: id,
        run: (input: AgentRunInput) => this.run({ ...input, agentName: name, agentId: id }),
        stream: (input: AgentRunInput) => this.stream({ ...input, agentName: name, agentId: id }),
      };
    }

    const ref = refOrName;
    if (!ref.id) throw new Error(`Agent ${ref.name} is missing a generated id. Run filthy-panty deploy first.`);

    return {
      id: ref.id,
      run: (input: AgentRunInput) => this.run(ref, input),
      stream: (input: AgentRunInput) => this.stream(ref, input),
    };
  }

  /** Run an agent and accumulate the streamed text and raw parts. */
  async run(ref: AgentReference, input: AgentRunInput): Promise<AgentRunResult>;
  async run(input: AgentRunInput & { agentId: string; agentName?: string }): Promise<AgentRunResult>;
  async run(
    refOrInput: AgentReference | (AgentRunInput & { agentId: string; agentName?: string }),
    maybeInput?: AgentRunInput,
  ): Promise<AgentRunResult> {
    const events: TextStreamPart<ToolSet>[] = [];
    let text = "";

    const stream = maybeInput
      ? this.stream(refOrInput as AgentReference, maybeInput)
      : this.stream(refOrInput as AgentRunInput & { agentId: string; agentName?: string });

    for await (const part of stream) {
      events.push(part);
      if (part.type === "text-delta") text += part.text;
    }

    return { text, events };
  }

  /** Stream an agent run, yielding each AI SDK `TextStreamPart` as it arrives. */
  stream(ref: AgentReference, input: AgentRunInput): AsyncGenerator<TextStreamPart<ToolSet>>;
  stream(input: AgentRunInput & { agentId: string; agentName?: string }): AsyncGenerator<TextStreamPart<ToolSet>>;
  async *stream(
    refOrInput: AgentReference | (AgentRunInput & { agentId: string; agentName?: string }),
    maybeInput?: AgentRunInput,
  ): AsyncGenerator<TextStreamPart<ToolSet>> {
    const input = maybeInput
      ? {
        ...maybeInput,
        agentId: (refOrInput as AgentReference).id,
        agentName: (refOrInput as AgentReference).name,
      }
      : refOrInput as AgentRunInput & { agentId: string; agentName?: string };
    const body = {
      agentId: input.agentId,
      eventId: input.eventId ?? `cli-${Date.now()}`,
      conversationKey: input.conversationKey ?? "cli",
      events: resolveRunEvents(input),
    };
    const targetUrl = maybeInput ? this.scopedUrl(refOrInput as AgentReference) : this.baseUrl;

    const response = await this.openStream(body, targetUrl);
    if (!response.ok) throw new Error(`Run failed: ${response.status} ${await response.text()}`);
    if (!response.body) throw new Error("Run response has no body");

    for await (const data of readSseStream(response.body)) {
      let part: TextStreamPart<ToolSet>;
      try {
        part = JSON.parse(data) as TextStreamPart<ToolSet>;
      } catch {
        // Skip non-JSON lines (e.g. a heartbeat comment that slipped through).
        continue;
      }
      // A fatal `error` part means the run aborted server-side (model/auth/tool
      // failure). Surface it instead of yielding it, so callers that only read
      // `text-delta` parts can never silently swallow a failed run.
      if (part.type === "error") throw new Error(`Agent run failed: ${formatStreamError(part.error)}`);
      yield part;
    }
  }

  /**
   * Scoped invoke URL for a deployed agent. When codegen embedded the runtime
   * key's scope, this is `/v1/{projectSlug}/agents/{environmentSlug}/{endpointId}`
   * (the same URL the dashboard shows, so core can validate the key against the
   * path); otherwise it falls back to the base URL.
   */
  private scopedUrl(ref: AgentReference): string {
    if (ref.projectSlug && ref.environmentSlug && ref.endpointId) {
      return `${this.baseUrl}/v1/${encodeURIComponent(ref.projectSlug)}` +
        `/agents/${encodeURIComponent(ref.environmentSlug)}/${encodeURIComponent(ref.endpointId)}`;
    }

    return this.baseUrl;
  }

  private async openStream(
    body: unknown,
    targetUrl: string,
  ): Promise<Response> {
    if (this.apiKey) {
      return await this.fetchCore(body, targetUrl, {
        "Authorization": `Bearer ${this.apiKey}`,
      });
    }

    throw new Error(
      `FilthyPantyClient streams directly from the core service at ${this.baseUrl}. ` +
      "Provide apiKey. " +
      "For a self-hosted core service, set host/baseUrl or FILTHY_PANTY_HOST/FILTHY_PANTY_BASE_URL.",
    );
  }

  private async fetchCore(body: unknown, targetUrl: string, authHeaders: Record<string, string>): Promise<Response> {
    try {
      return await this.fetchImpl(targetUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "text/event-stream",
          ...authHeaders,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new Error(
        `Cannot access the filthy-panty core service at ${targetUrl}. ` +
        `The SDK uses ${DEFAULT_CORE_BASE_URL} by default; set host/baseUrl or FILTHY_PANTY_HOST/FILTHY_PANTY_BASE_URL ` +
        `to your own core service URL if your account uses a custom deployment. ` +
        `Cause: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export function normalizeHttpServiceUrl(value: string): string {
  const trimmed = value.trim();
  const withProtocol = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;

  return stripTrailingSlash(withProtocol);
}

/**
 * Resolves a run's events from either the explicit `events` list or the `input`
 * string shorthand, matching the core direct API's event contract. Throws when
 * neither is provided so a missing prompt fails fast instead of sending an empty
 * request the server rejects.
 */
function resolveRunEvents(input: AgentRunInput): ModelMessage[] {
  if (input.events && input.input !== undefined) {
    throw new Error("AgentRunInput accepts either `input` or `events`, not both");
  }
  if (input.events && input.events.length > 0) return input.events;
  if (typeof input.input === "string") {
    return [{ role: "user", content: [{ type: "text", text: input.input }] }];
  }

  throw new Error("AgentRunInput requires `input` (string) or a non-empty `events` array");
}

/**
 * Render a streamed `error` part into a single human-readable line. Handles the
 * AI SDK's `APICallError` shape (a nested provider error under `data.error` or a
 * raw `responseBody`) and falls back to `message`/JSON so no failure mode is lost.
 */
function formatStreamError(error: unknown): string {
  if (typeof error === "string") return error;
  if (!error || typeof error !== "object") return String(error);
  const err = error as {
    name?: string;
    message?: string;
    statusCode?: number;
    responseBody?: string;
    data?: { error?: { message?: string } };
  };
  const detail =
    err.data?.error?.message ??
    err.message ??
    err.responseBody ??
    JSON.stringify(error);
  const prefix = err.name ? `${err.name}: ` : "";
  const status = err.statusCode ? ` (HTTP ${err.statusCode})` : "";

  return `${prefix}${detail}${status}`;
}

/** Yield the payload of each `data:` line from an SSE response body. */
export async function* readSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data: ")) yield line.slice(6);
      }
    }
  } finally {
    reader.releaseLock();
  }
}
