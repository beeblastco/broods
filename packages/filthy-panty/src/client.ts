/**
 * Configurable client for running deployed agents over direct core SSE.
 * Stream chunks are the Vercel AI SDK's `TextStreamPart` parts that core emits.
 */

import type { TextStreamPart, ToolSet } from "ai";
import { loadFilthyPantyRuntimeConfig } from "./runtime-config.ts";
import { stripTrailingSlash } from "./config.ts";
import { resolveRunEvents, type AgentRunEventInput, type AgentRunOverrides } from "./run-input.ts";
import { readSseStream } from "./stream.ts";
import type {
  AsyncRequestAccepted,
  AsyncStatus,
  Cron,
  CronRun,
} from "./types.ts";
import type { CreateCronInput, UpdateCronInput } from "./contracts.ts";

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
} & AgentRunOverrides;

export type AgentRunInput = AgentRunInputBase & AgentRunEventInput;

export interface AgentRunResult {
  text: string;
  events: TextStreamPart<ToolSet>[];
}

export interface AsyncPollOptions {
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface AsyncAgentRun extends AsyncRequestAccepted {
  conversationKey: string;
  poll(): Promise<AsyncStatus>;
  wait(options?: AsyncPollOptions): Promise<AsyncStatus>;
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

export interface ChannelReference {
  readonly kind: "channel";
  readonly type: "telegram" | "github" | "slack" | "discord" | "pancake" | "zalo";
  readonly agentName: string;
  readonly agentId: string;
  readonly accountId: string;
  readonly webhookPath: string;
}

export interface ResourceApi {
  readonly agents: Record<string, AgentReference>;
  readonly channels?: Record<string, ChannelReference>;
  readonly workspaces?: Record<string, unknown>;
  readonly sandboxes?: Record<string, unknown>;
  readonly crons?: Record<string, unknown>;
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
  runAsync: (input: AgentRunInput) => Promise<AsyncAgentRun>;
  stream: (input: AgentRunInput) => AsyncGenerator<TextStreamPart<ToolSet>>;
};

export type CreateClientCronInput =
  | CreateCronInput
  | (Omit<CreateCronInput, "agentId"> & { agent: AgentReference | string });

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

  /** Return the public provider webhook URL for a generated channel reference. */
  channelWebhookUrl(ref: ChannelReference): string {
    return `${this.baseUrl}${ref.webhookPath.startsWith("/") ? "" : "/"}${ref.webhookPath}`;
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
        runAsync: (input: AgentRunInput) => this.runAsync({ ...input, agentName: name, agentId: id }),
        stream: (input: AgentRunInput) => this.stream({ ...input, agentName: name, agentId: id }),
      };
    }

    const ref = refOrName;
    if (!ref.id) throw new Error(`Agent ${ref.name} is missing a generated id. Run filthy-panty deploy first.`);

    return {
      id: ref.id,
      run: (input: AgentRunInput) => this.run(ref, input),
      runAsync: (input: AgentRunInput) => this.runAsync(ref, input),
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
    const body = directRunBody(input, "cli");
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

  /** Start an async agent run and return the status id/URL used for polling. */
  async runAsync(ref: AgentReference, input: AgentRunInput): Promise<AsyncAgentRun>;
  async runAsync(input: AgentRunInput & { agentId: string; agentName?: string }): Promise<AsyncAgentRun>;
  async runAsync(
    refOrInput: AgentReference | (AgentRunInput & { agentId: string; agentName?: string }),
    maybeInput?: AgentRunInput,
  ): Promise<AsyncAgentRun> {
    const input = maybeInput
      ? {
        ...maybeInput,
        agentId: (refOrInput as AgentReference).id,
        agentName: (refOrInput as AgentReference).name,
      }
      : refOrInput as AgentRunInput & { agentId: string; agentName?: string };
    const body = directRunBody(input, "async");
    const response = await this.fetchJson(`${this.baseUrl}/async`, {
      method: "POST",
      headers: this.apiKeyHeaders(),
      body: JSON.stringify(body),
    });
    if (response.status !== 202) {
      throw new Error(`Async run failed: ${response.status} ${await responseErrorDetails(response, "202 JSON")}`);
    }

    const accepted = normalizeAsyncAccepted(await response.json(), body);

    return {
      ...accepted,
      conversationKey: body.conversationKey,
      poll: () => this.getAsyncStatus(accepted),
      wait: (options?: AsyncPollOptions) => this.waitForAsyncStatus(accepted, options),
    };
  }

  /** Fetch one async status snapshot by status URL or status id + agent id. */
  async getAsyncStatus(
    status: AsyncRequestAccepted | string,
    options: { agentId?: string } = {},
  ): Promise<AsyncStatus> {
    const statusUrl = this.resolveStatusUrl(status, options);
    const response = await this.fetchJson(statusUrl, {
      method: "GET",
      headers: this.apiKeyHeaders(),
    });

    if (response.status === 404) return { status: "not_found" };
    if (!response.ok) throw new Error(`Status check failed: ${response.status} ${await response.text()}`);

    return await response.json() as AsyncStatus;
  }

  /** Poll async status until it reaches completed, failed, awaiting_approval, or timeout. */
  async waitForAsyncStatus(
    status: AsyncRequestAccepted | string,
    options: AsyncPollOptions & { agentId?: string } = {},
  ): Promise<AsyncStatus> {
    const deadline = Date.now() + (options.timeoutMs ?? 180_000);
    const intervalMs = options.intervalMs ?? 2_000;

    while (Date.now() < deadline) {
      if (options.signal?.aborted) throw new Error("Async status polling aborted.");
      const payload = await this.getAsyncStatus(status, options);
      if (payload.status === "awaiting_approval" || payload.status === "completed" || payload.status === "failed" || payload.status === "not_found") {
        return payload;
      }
      await sleep(intervalMs, options.signal);
    }

    throw new Error("Polling timeout");
  }

  async createCron(input: CreateClientCronInput): Promise<Cron> {
    const response = await this.fetchJson(`${this.baseUrl}/accounts/me/crons`, {
      method: "POST",
      headers: this.apiKeyHeaders(),
      body: JSON.stringify(resolveCronInput(input)),
    });

    if (response.status !== 201) throw new Error(`Create cron job failed: ${response.status} ${await cronErrorDetails(response)}`);

    return await response.json() as Cron;
  }

  async listCrons(): Promise<Cron[]> {
    const response = await this.fetchJson(`${this.baseUrl}/accounts/me/crons`, {
      method: "GET",
      headers: this.apiKeyHeaders(),
    });

    if (!response.ok) throw new Error(`List cron jobs failed: ${response.status} ${await cronErrorDetails(response)}`);

    const payload = await response.json() as { crons: Cron[] };

    return payload.crons;
  }

  async getCron(cronId: string): Promise<Cron | null> {
    const response = await this.fetchJson(`${this.baseUrl}/accounts/me/crons/${encodeURIComponent(cronId)}`, {
      method: "GET",
      headers: this.apiKeyHeaders(),
    });

    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Get cron job failed: ${response.status} ${await cronErrorDetails(response)}`);

    return await response.json() as Cron;
  }

  async listCronRuns(cronId: string, options: { limit?: number } = {}): Promise<CronRun[]> {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    const suffix = params.size > 0 ? `?${params}` : "";
    const response = await this.fetchJson(
      `${this.baseUrl}/accounts/me/crons/${encodeURIComponent(cronId)}/runs${suffix}`,
      {
        method: "GET",
        headers: this.apiKeyHeaders(),
      },
    );

    if (!response.ok) throw new Error(`List cron job runs failed: ${response.status} ${await cronErrorDetails(response)}`);

    const payload = await response.json() as { runs: CronRun[] };

    return payload.runs;
  }

  async updateCron(cronId: string, patch: UpdateCronInput): Promise<Cron> {
    const response = await this.fetchJson(`${this.baseUrl}/accounts/me/crons/${encodeURIComponent(cronId)}`, {
      method: "PATCH",
      headers: this.apiKeyHeaders(),
      body: JSON.stringify(patch),
    });

    if (!response.ok) throw new Error(`Update cron job failed: ${response.status} ${await cronErrorDetails(response)}`);

    return await response.json() as Cron;
  }

  async deleteCron(cronId: string): Promise<boolean> {
    const response = await this.fetchJson(`${this.baseUrl}/accounts/me/crons/${encodeURIComponent(cronId)}`, {
      method: "DELETE",
      headers: this.apiKeyHeaders(),
    });

    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`Delete cron job failed: ${response.status} ${await cronErrorDetails(response)}`);

    const payload = await response.json() as { deleted: boolean };

    return payload.deleted;
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

  private apiKeyHeaders(): Record<string, string> {
    if (!this.apiKey) {
      throw new Error(
        "FilthyPantyClient requires apiKey or FILTHY_PANTY_API_KEY.",
      );
    }

    return {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${this.apiKey}`,
    };
  }

  private async fetchJson(targetUrl: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(targetUrl, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
      });
    } catch (error) {
      throw new Error(
        `Cannot access the filthy-panty core service at ${targetUrl}. ` +
        `Cause: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private resolveStatusUrl(status: AsyncRequestAccepted | string, options: { agentId?: string }): string {
    if (typeof status !== "string") return status.statusUrl;
    if (/^https?:\/\//.test(status)) return status;
    if (!options.agentId) throw new Error("Polling by status id requires agentId.");

    return statusUrlFor(this.baseUrl, status, options.agentId);
  }
}

export function normalizeHttpServiceUrl(value: string): string {
  const trimmed = value.trim();
  const withProtocol = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;

  return stripTrailingSlash(withProtocol);
}

function directRunBody(input: AgentRunInput & { agentId: string; agentName?: string }, prefix: "cli" | "async") {
  const eventId = input.eventId ?? `${prefix}-${Date.now()}`;

  return {
    agentId: input.agentId,
    eventId,
    conversationKey: input.conversationKey ?? eventId,
    events: resolveRunEvents(input),
    ...(input.system !== undefined ? { system: input.system } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
  };
}

function normalizeAsyncAccepted(payload: unknown, requestBody: { agentId: string }): AsyncRequestAccepted {
  if (!payload || typeof payload !== "object") {
    throw new Error("Async response must be an object");
  }
  const statusUrl = (payload as { statusUrl?: unknown }).statusUrl;
  if (typeof statusUrl !== "string" || statusUrl.length === 0) {
    throw new Error("Async response missing statusUrl");
  }
  const status = parseStatusUrl(statusUrl);
  if (!status.statusId) throw new Error("Async response statusUrl missing status id");

  return {
    statusUrl,
    statusId: status.statusId,
    eventId: status.statusId,
    agentId: status.agentId ?? requestBody.agentId,
  };
}

function parseStatusUrl(statusUrl: string): { statusId?: string; agentId?: string } {
  const url = new URL(statusUrl);
  const match = url.pathname.match(/\/status\/([^/]+)$/);

  return {
    statusId: match?.[1] ? decodeURIComponent(match[1]) : undefined,
    agentId: url.searchParams.get("agentId") ?? undefined,
  };
}

function statusUrlFor(baseUrl: string, statusId: string, agentId: string): string {
  return `${normalizeHttpServiceUrl(baseUrl)}/status/${encodeURIComponent(statusId)}?agentId=${encodeURIComponent(agentId)}`;
}

async function responseErrorDetails(response: Response, expected: string): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().includes("text/event-stream")) {
    await response.body?.cancel().catch(() => {});
    return `expected ${expected}, but the server returned an SSE stream. This usually means the core deployment routed /async to the direct streaming runner instead of the async handler.`;
  }

  const text = await response.text();
  if (text.length <= 2_000) return text;

  return `${text.slice(0, 2_000)}... [truncated ${text.length - 2_000} chars]`;
}

async function cronErrorDetails(response: Response): Promise<string> {
  const text = await response.text();
  if (text.includes("Request body must include eventId and conversationKey")) {
    return `${text}. Cron job APIs must be served by the configured baseUrl. ` +
      "Prefer defining stable cron jobs with defineCron(...) in filthypanty/ and syncing with `filthy-panty dev` or `filthy-panty deploy`.";
  }

  return text;
}

function resolveCronInput(input: CreateClientCronInput): CreateCronInput {
  if ("agentId" in input) return input;
  const agent = input.agent;
  const agentId = typeof agent === "string" ? agent : agent.id;
  const { agent: _agent, ...rest } = input;

  // Spreading erases the input|events discrimination; the caller already
  // supplied a valid one-of, so re-assert the union shape.
  return { ...rest, agentId } as CreateCronInput;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(new Error("Async status polling aborted."));
      return;
    }
    const timer = setTimeout(resolvePromise, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Async status polling aborted."));
    }, { once: true });
  });
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
