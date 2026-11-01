import type { ModelMessage, TextStreamPart, ToolSet } from "ai";
import { loadBroodsRuntimeConfig } from "./runtime-config.ts";
import { stripTrailingSlash } from "./config.ts";
import {
  resolveRunEvents,
  type AgentRunEventInput,
  type AgentRunOverrides,
} from "./run-input.ts";
import { readSseStream } from "./stream.ts";
import type { AsyncRequestAccepted, AsyncStatus } from "./types.ts";
import { USER_TOKEN_HEADER } from "./user-token.ts";

export const DEFAULT_CORE_BASE_URL = "https://gateway.broods.app";

type AgentRunInputBase = {
  conversationKey?: string;
  eventId?: string;
  /** When the conversation is busy. Default `steer` joins the live run at its next step. */
  mode?: "reject" | "followup" | "collect" | "steer";
  /** Defaults to `eventId`. */
  idempotencyKey?: string;
} & AgentRunOverrides;

export type AgentRunInput = AgentRunInputBase & AgentRunEventInput;

export interface AgentRunResult {
  text: string;
  events: TextStreamPart<ToolSet>[];
}

export interface AgentContinueInput {
  /** The key given to `run`, or the scoped key a dashboard trace row shows. */
  conversationKey: string;
  eventId?: string;
}

export class IngressAcceptedError extends Error {
  constructor(public readonly accepted: AsyncRequestAccepted) {
    super(
      `Ingress ${accepted.eventId} was accepted asynchronously with status ${accepted.status ?? "queued"}`,
    );
    this.name = "IngressAcceptedError";
  }
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
  readonly stage: string;
  readonly endpointId?: string;
  readonly projectSlug?: string;
  readonly stageSlug?: string;
}

export interface ChannelReference {
  readonly kind: "channel";
  readonly type:
    | "telegram"
    | "gchat"
    | "github"
    | "linear"
    | "slack"
    | "discord"
    | "matrix"
    | "pancake"
    | "teams"
    | "twilio"
    | "zalo"
    | "whatsapp"
    | "instagram"
    | "messenger";
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
  readonly policies?: Record<string, unknown>;
}

export interface BroodsClientOptions {
  baseUrl?: string;
  host?: string;
  apiKey?: string;
  /**
   * Sent beside the runtime key; an agent that requires one refuses the key alone.
   * A function fetches a fresh token per call, e.g. one your backend signs with `signUserToken`.
   */
  userToken?: string | (() => string | Promise<string>);
  fetch?: typeof fetch;
}

export type AgentHandle = {
  id: string;
  run: (input: AgentRunInput) => Promise<AgentRunResult>;
  runAsync: (input: AgentRunInput) => Promise<AsyncAgentRun>;
  continue: (input: AgentContinueInput) => Promise<AsyncAgentRun>;
  stream: (input: AgentRunInput) => AsyncGenerator<TextStreamPart<ToolSet>>;
};

export class BroodsClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly userToken?: BroodsClientOptions["userToken"];
  private readonly fetchImpl: typeof fetch;

  constructor(options: BroodsClientOptions = {}) {
    loadBroodsRuntimeConfig();
    this.baseUrl = normalizeHttpServiceUrl(
      options.baseUrl ||
        options.host ||
        process.env.BROODS_BASE_URL ||
        process.env.BROODS_HOST ||
        DEFAULT_CORE_BASE_URL,
    );
    this.apiKey = options.apiKey || process.env.BROODS_API_KEY || undefined;
    this.userToken = options.userToken;
    this.fetchImpl = options.fetch ?? fetch;
  }

  channelWebhookUrl(ref: ChannelReference): string {
    return `${this.baseUrl}${ref.webhookPath.startsWith("/") ? "" : "/"}${ref.webhookPath}`;
  }

  /** Names no agent: paste it into the provider when several agents share one app. */
  accountWebhookUrl(
    accountId: string,
    channelType: ChannelReference["type"],
  ): string {
    const segments = [accountId, channelType].map(encodeURIComponent);

    return `${this.baseUrl}/v1/webhooks/${segments.join("/")}`;
  }

  /** Pinned to one non-production stage; production uses `accountWebhookUrl`. */
  stageWebhookUrl(
    accountId: string,
    endpointId: string,
    channelType: ChannelReference["type"],
  ): string {
    const segments = [accountId, "dev", endpointId, channelType].map(
      encodeURIComponent,
    );

    return `${this.baseUrl}/v1/webhooks/${segments.join("/")}`;
  }

  agent<const Name extends string>(ref: AgentReference<Name>): AgentHandle;
  agent(name: string, agentId: string): AgentHandle;
  agent(refOrName: AgentReference | string, agentId?: string): AgentHandle {
    if (typeof refOrName === "string") {
      const name = refOrName;
      const id = agentId ?? "";
      if (!id)
        throw new Error(
          `Agent ${name} is missing a generated id. Run broods dev --once or broods deploy to sync it first.`,
        );

      return {
        id: id,
        run: (input: AgentRunInput) =>
          this.run({ ...input, agentName: name, agentId: id }),
        runAsync: (input: AgentRunInput) =>
          this.runAsync({ ...input, agentName: name, agentId: id }),
        continue: (input: AgentContinueInput) =>
          this.continue({ ...input, agentId: id }),
        stream: (input: AgentRunInput) =>
          this.stream({ ...input, agentName: name, agentId: id }),
      };
    }

    const ref = refOrName;
    if (!ref.id)
      throw new Error(
        `Agent ${ref.name} is missing a generated id. Run broods dev --once or broods deploy to sync it first.`,
      );

    return {
      id: ref.id,
      run: (input: AgentRunInput) => this.run(ref, input),
      runAsync: (input: AgentRunInput) => this.runAsync(ref, input),
      continue: (input: AgentContinueInput) => this.continue(ref, input),
      stream: (input: AgentRunInput) => this.stream(ref, input),
    };
  }

  async run(ref: AgentReference, input: AgentRunInput): Promise<AgentRunResult>;
  async run(
    input: AgentRunInput & { agentId: string; agentName?: string },
  ): Promise<AgentRunResult>;
  async run(
    refOrInput:
      | AgentReference
      | (AgentRunInput & { agentId: string; agentName?: string }),
    maybeInput?: AgentRunInput,
  ): Promise<AgentRunResult> {
    const events: TextStreamPart<ToolSet>[] = [];
    let text = "";

    const stream = maybeInput
      ? this.stream(refOrInput as AgentReference, maybeInput)
      : this.stream(
          refOrInput as AgentRunInput & { agentId: string; agentName?: string },
        );

    for await (const part of stream) {
      events.push(part);
      if (part.type === "text-delta") text += part.text;
    }

    return { text: text, events: events };
  }

  stream(
    ref: AgentReference,
    input: AgentRunInput,
  ): AsyncGenerator<TextStreamPart<ToolSet>>;
  stream(
    input: AgentRunInput & { agentId: string; agentName?: string },
  ): AsyncGenerator<TextStreamPart<ToolSet>>;
  async *stream(
    refOrInput:
      | AgentReference
      | (AgentRunInput & { agentId: string; agentName?: string }),
    maybeInput?: AgentRunInput,
  ): AsyncGenerator<TextStreamPart<ToolSet>> {
    const input = maybeInput
      ? {
          ...maybeInput,
          agentId: (refOrInput as AgentReference).id,
          agentName: (refOrInput as AgentReference).name,
        }
      : (refOrInput as AgentRunInput & { agentId: string; agentName?: string });
    const body = directRunBody(input, "cli");
    const targetUrl = maybeInput
      ? this.scopedUrl(refOrInput as AgentReference)
      : `${this.baseUrl}/v1/runs`;

    const response = await this.openStream(body, targetUrl);
    if (!response.ok)
      throw new Error(
        `Run failed: ${response.status} ${await response.text()}`,
      );
    if (response.status === 202) {
      throw new IngressAcceptedError(
        normalizeAsyncAccepted(await response.json(), body),
      );
    }
    if (!response.body) throw new Error("Run response has no body");

    for await (const data of readSseStream(response.body)) {
      let part: TextStreamPart<ToolSet>;
      try {
        part = JSON.parse(data) as TextStreamPart<ToolSet>;
      } catch {
        continue;
      }
      // Thrown, not yielded, so a caller reading only `text-delta` cannot miss a failed run.
      if (part.type === "error")
        throw new Error(`Agent run failed: ${formatStreamError(part.error)}`);
      yield part;
    }
  }

  async runAsync(
    ref: AgentReference,
    input: AgentRunInput,
  ): Promise<AsyncAgentRun>;
  async runAsync(
    input: AgentRunInput & { agentId: string; agentName?: string },
  ): Promise<AsyncAgentRun>;
  async runAsync(
    refOrInput:
      | AgentReference
      | (AgentRunInput & { agentId: string; agentName?: string }),
    maybeInput?: AgentRunInput,
  ): Promise<AsyncAgentRun> {
    const input = maybeInput
      ? {
          ...maybeInput,
          agentId: (refOrInput as AgentReference).id,
          agentName: (refOrInput as AgentReference).name,
        }
      : (refOrInput as AgentRunInput & { agentId: string; agentName?: string });
    const body = { ...directRunBody(input, "async"), background: true };
    const targetUrl = maybeInput
      ? this.scopedUrl(refOrInput as AgentReference)
      : `${this.baseUrl}/v1/runs`;

    return this.postAcceptedRun(targetUrl, body, "Async run");
  }

  /** Re-enter a conversation whose last turn stopped short (step cap, provider fault). */
  async continue(
    ref: AgentReference,
    input: AgentContinueInput,
  ): Promise<AsyncAgentRun>;
  async continue(
    input: AgentContinueInput & { agentId: string },
  ): Promise<AsyncAgentRun>;
  async continue(
    refOrInput: AgentReference | (AgentContinueInput & { agentId: string }),
    maybeInput?: AgentContinueInput,
  ): Promise<AsyncAgentRun> {
    const ref = maybeInput ? (refOrInput as AgentReference) : null;
    const input = maybeInput ?? (refOrInput as AgentContinueInput);
    const body = {
      agentId: ref ? ref.id : (refOrInput as { agentId: string }).agentId,
      eventId: input.eventId ?? `continue-${crypto.randomUUID()}`,
      conversationKey: input.conversationKey,
      continue: true,
    };
    const targetUrl = ref ? this.scopedUrl(ref) : `${this.baseUrl}/v1/runs`;

    return this.postAcceptedRun(targetUrl, body, "Continue");
  }

  async getAsyncStatus(
    status: AsyncRequestAccepted | string,
  ): Promise<AsyncStatus> {
    const statusUrl = this.resolveStatusUrl(status);
    const response = await this.fetchJson(statusUrl, {
      method: "GET",
      headers: await this.apiKeyHeaders(),
    });

    if (response.status === 404) return { status: "not_found" };
    if (!response.ok)
      throw new Error(
        `Status check failed: ${response.status} ${await response.text()}`,
      );

    return (await response.json()) as AsyncStatus;
  }

  async waitForAsyncStatus(
    status: AsyncRequestAccepted | string,
    options: AsyncPollOptions = {},
  ): Promise<AsyncStatus> {
    const deadline = Date.now() + (options.timeoutMs ?? 180_000);
    const intervalMs = options.intervalMs ?? 2_000;

    while (Date.now() < deadline) {
      if (options.signal?.aborted)
        throw new Error("Async status polling aborted.");
      const payload = await this.getAsyncStatus(status);
      if (
        payload.status === "awaiting_approval" ||
        payload.status === "awaiting_input" ||
        payload.status === "completed" ||
        payload.status === "failed" ||
        payload.status === "expired" ||
        payload.status === "not_found"
      ) {
        return payload;
      }
      await sleep(intervalMs, options.signal);
    }

    throw new Error("Polling timeout");
  }

  // The dashboard's URL for the agent, so core can check the runtime key against the path.
  private scopedUrl(ref: AgentReference): string {
    if (ref.projectSlug && ref.stageSlug && ref.endpointId) {
      return (
        `${this.baseUrl}/v1/projects/${encodeURIComponent(ref.projectSlug)}` +
        `/stages/${encodeURIComponent(ref.stageSlug)}` +
        `/agents/${encodeURIComponent(ref.endpointId)}`
      );
    }

    return `${this.baseUrl}/v1/runs`;
  }

  private asyncAgentRun(
    accepted: AsyncRequestAccepted,
    conversationKey: string,
  ): AsyncAgentRun {
    return {
      ...accepted,
      conversationKey: conversationKey,
      poll: () => this.getAsyncStatus(accepted),
      wait: (options?: AsyncPollOptions) =>
        this.waitForAsyncStatus(accepted, options),
    };
  }

  private async postAcceptedRun(
    targetUrl: string,
    body: { agentId: string; conversationKey: string },
    label: string,
  ): Promise<AsyncAgentRun> {
    const response = await this.fetchJson(targetUrl, {
      method: "POST",
      headers: await this.apiKeyHeaders(),
      body: JSON.stringify(body),
    });
    if (response.status !== 202) {
      throw new Error(
        `${label} failed: ${response.status} ${await responseErrorDetails(response, "202 JSON")}`,
      );
    }

    return this.asyncAgentRun(
      normalizeAsyncAccepted(await response.json(), body),
      body.conversationKey,
    );
  }

  private async openStream(
    body: unknown,
    targetUrl: string,
  ): Promise<Response> {
    if (this.apiKey) {
      return await this.fetchCore(body, targetUrl, {
        Authorization: `Bearer ${this.apiKey}`,
        ...(await this.userTokenHeaders()),
      });
    }

    throw new Error(
      `BroodsClient streams directly from the core service at ${this.baseUrl}. ` +
        "Provide apiKey. " +
        "For a self-hosted core service, set host/baseUrl or BROODS_HOST/BROODS_BASE_URL.",
    );
  }

  private async fetchCore(
    body: unknown,
    targetUrl: string,
    authHeaders: Record<string, string>,
  ): Promise<Response> {
    try {
      return await this.fetchImpl(targetUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          ...authHeaders,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new Error(
        `Cannot access the broods core service at ${targetUrl}. ` +
          `The SDK uses ${DEFAULT_CORE_BASE_URL} by default; set host/baseUrl or BROODS_HOST/BROODS_BASE_URL ` +
          `to your own core service URL if your account uses a custom deployment. ` +
          `Cause: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async apiKeyHeaders(): Promise<Record<string, string>> {
    if (!this.apiKey) {
      throw new Error("BroodsClient requires apiKey or BROODS_API_KEY.");
    }

    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      ...(await this.userTokenHeaders()),
    };
  }

  private async userTokenHeaders(): Promise<Record<string, string>> {
    const token =
      typeof this.userToken === "function"
        ? await this.userToken()
        : this.userToken;

    return token ? { [USER_TOKEN_HEADER]: token } : {};
  }

  private async fetchJson(
    targetUrl: string,
    init: RequestInit,
  ): Promise<Response> {
    try {
      return await this.fetchImpl(targetUrl, init);
    } catch (error) {
      throw new Error(
        `Cannot access the broods core service at ${targetUrl}. ` +
          `Cause: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private resolveStatusUrl(status: AsyncRequestAccepted | string): string {
    if (typeof status !== "string") return status.statusUrl;
    if (/^https?:\/\//.test(status)) return status;

    return statusUrlFor(this.baseUrl, status);
  }
}

export function normalizeHttpServiceUrl(value: string): string {
  const trimmed = value.trim();
  const withProtocol = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  return stripTrailingSlash(withProtocol);
}

function directRunBody(
  input: AgentRunInput & { agentId: string; agentName?: string },
  prefix: "cli" | "async",
): {
  agentId: string;
  eventId: string;
  conversationKey: string;
  events: ModelMessage[];
  mode?: AgentRunInput["mode"];
  idempotencyKey?: string;
  system?: AgentRunOverrides["system"];
  model?: AgentRunOverrides["model"];
} {
  const eventId = input.eventId ?? `${prefix}-${crypto.randomUUID()}`;

  return {
    agentId: input.agentId,
    eventId: eventId,
    conversationKey: input.conversationKey ?? eventId,
    events: resolveRunEvents(input),
    ...(input.mode !== undefined ? { mode: input.mode } : {}),
    ...(input.idempotencyKey !== undefined
      ? { idempotencyKey: input.idempotencyKey }
      : {}),
    ...(input.system !== undefined ? { system: input.system } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
  };
}

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

function normalizeAsyncAccepted(
  payload: unknown,
  requestBody: { agentId: string },
): AsyncRequestAccepted {
  if (!payload || typeof payload !== "object") {
    throw new Error("Async response must be an object");
  }
  const statusUrl = (payload as { statusUrl?: unknown }).statusUrl;
  if (typeof statusUrl !== "string" || statusUrl.length === 0) {
    throw new Error("Async response missing statusUrl");
  }
  const runId = (payload as { runId?: unknown }).runId;
  if (typeof runId !== "string" || runId.length === 0) {
    throw new Error("Async response missing runId");
  }

  const eventId =
    typeof (payload as { eventId?: unknown }).eventId === "string"
      ? (payload as { eventId: string }).eventId
      : runId;
  const acceptedStatus = (payload as { status?: unknown }).status;
  const requestedMode = (payload as { requestedMode?: unknown }).requestedMode;

  return {
    statusUrl: statusUrl,
    runId: runId,
    eventId: eventId,
    agentId: requestBody.agentId,
    ...(acceptedStatus === "accepted" ||
    acceptedStatus === "queued" ||
    acceptedStatus === "applied" ||
    acceptedStatus === "processing"
      ? { status: acceptedStatus }
      : {}),
    ...(requestedMode === "reject" ||
    requestedMode === "followup" ||
    requestedMode === "collect" ||
    requestedMode === "steer"
      ? { requestedMode: requestedMode }
      : {}),
  };
}

async function responseErrorDetails(
  response: Response,
  expected: string,
): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().includes("text/event-stream")) {
    await response.body?.cancel().catch(() => {});

    return `expected ${expected}, but the server returned an SSE stream. This usually means the core deployment ignored the background flag and ran the request on the direct streaming runner.`;
  }

  const text = await response.text();
  if (text.length <= 2_000) return text;

  return `${text.slice(0, 2_000)}... [truncated ${text.length - 2_000} chars]`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(new Error("Async status polling aborted."));

      return;
    }
    const timer = setTimeout(resolvePromise, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Async status polling aborted."));
      },
      { once: true },
    );
  });
}

function statusUrlFor(baseUrl: string, runId: string): string {
  return `${normalizeHttpServiceUrl(baseUrl)}/v1/runs/${encodeURIComponent(runId)}`;
}
