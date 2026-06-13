/**
 * Configurable client for running deployed agents over SSE, via either the
 * dashboard CLI API (token auth) or the harness Function URL (account secret).
 * Stream chunks are the Vercel AI SDK's `TextStreamPart` parts that core emits.
 */

import type { TextStreamPart, ToolSet } from "ai";
import { FilthyPantySyncClient } from "./sync.ts";
import { loadFilthyPantyRuntimeConfig } from "./runtime-config.ts";

export interface AgentRunInput {
  input: string;
  conversationKey?: string;
  eventId?: string;
}

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
  dashboardUrl?: string;
  token?: string;
  project?: string;
  environment?: string;
  agentServiceUrl?: string;
  accountSecret?: string;
  fetch?: typeof fetch;
}

export type AgentHandle = {
  id: string;
  run: (input: AgentRunInput) => Promise<AgentRunResult>;
  stream: (input: AgentRunInput) => AsyncGenerator<TextStreamPart<ToolSet>>;
};

export class FilthyPantyClient {
  private readonly dashboardUrl?: string;
  private readonly token?: string;
  private readonly project?: string;
  private readonly environment?: string;
  private readonly agentServiceUrl?: string;
  private readonly accountSecret?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: FilthyPantyClientOptions = {}) {
    const runtime = loadFilthyPantyRuntimeConfig();
    this.dashboardUrl = options.dashboardUrl ?? runtime.dashboardUrl;
    this.token = options.token ?? runtime.token;
    this.project = options.project ?? runtime.project;
    this.environment = options.environment ?? runtime.environment;
    this.agentServiceUrl = options.agentServiceUrl ?? process.env.AGENT_SERVICE_URL;
    this.accountSecret = options.accountSecret ?? process.env.ACCOUNT_SECRET;
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
  async run(input: AgentRunInput & { agentId: string; agentName?: string; project?: string; environment?: string }): Promise<AgentRunResult>;
  async run(
    refOrInput: AgentReference | (AgentRunInput & { agentId: string; agentName?: string; project?: string; environment?: string }),
    maybeInput?: AgentRunInput,
  ): Promise<AgentRunResult> {
    const events: TextStreamPart<ToolSet>[] = [];
    let text = "";

    const stream = maybeInput
      ? this.stream(refOrInput as AgentReference, maybeInput)
      : this.stream(refOrInput as AgentRunInput & { agentId: string; agentName?: string; project?: string; environment?: string });

    for await (const part of stream) {
      events.push(part);
      if (part.type === "text-delta") text += part.text;
    }

    return { text, events };
  }

  /** Stream an agent run, yielding each AI SDK `TextStreamPart` as it arrives. */
  stream(ref: AgentReference, input: AgentRunInput): AsyncGenerator<TextStreamPart<ToolSet>>;
  stream(input: AgentRunInput & { agentId: string; agentName?: string; project?: string; environment?: string }): AsyncGenerator<TextStreamPart<ToolSet>>;
  async *stream(
    refOrInput: AgentReference | (AgentRunInput & { agentId: string; agentName?: string; project?: string; environment?: string }),
    maybeInput?: AgentRunInput,
  ): AsyncGenerator<TextStreamPart<ToolSet>> {
    const input = maybeInput
      ? {
        ...maybeInput,
        agentId: (refOrInput as AgentReference).id,
        agentName: (refOrInput as AgentReference).name,
        project: (refOrInput as AgentReference).project,
        environment: (refOrInput as AgentReference).environment,
      }
      : refOrInput as AgentRunInput & { agentId: string; agentName?: string; project?: string; environment?: string };
    const body = {
      agentId: input.agentId,
      eventId: input.eventId ?? `cli-${Date.now()}`,
      conversationKey: input.conversationKey ?? "cli",
      events: [{ role: "user", content: [{ type: "text", text: input.input }] }],
    };

    const response = await this.openStream(input.agentName, body, input.project, input.environment);
    if (!response.ok) throw new Error(`Run failed: ${response.status} ${await response.text()}`);
    if (!response.body) throw new Error("Run response has no body");

    for await (const data of readSseStream(response.body)) {
      try {
        yield JSON.parse(data) as TextStreamPart<ToolSet>;
      } catch {
        // Skip non-JSON lines (e.g. a heartbeat comment that slipped through).
      }
    }
  }

  private async openStream(
    agentName: string | undefined,
    body: unknown,
    project?: string,
    environment?: string,
  ): Promise<Response> {
    const resolvedProject = project ?? this.project;
    const resolvedEnvironment = environment ?? this.environment;
    if (this.dashboardUrl && this.token && resolvedProject && resolvedEnvironment && agentName) {
      const sync = new FilthyPantySyncClient({
        dashboardUrl: this.dashboardUrl,
        token: this.token,
        fetch: this.fetchImpl,
      });

      return await sync.run(resolvedProject, resolvedEnvironment, agentName, body);
    }

    if (this.agentServiceUrl && this.accountSecret) {
      return await this.fetchImpl(this.agentServiceUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "text/event-stream",
          "Authorization": `Bearer ${this.accountSecret}`,
        },
        body: JSON.stringify(body),
      });
    }

    throw new Error(
      "FilthyPantyClient requires either dashboardUrl/token/project/environment or agentServiceUrl/accountSecret",
    );
  }
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
