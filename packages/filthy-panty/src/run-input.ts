import type { CallSettings, ModelMessage, SystemModelMessage, streamText } from "ai";

type StreamTextOptions = Parameters<typeof streamText>[0];
type JsonCallSettings = Partial<Omit<CallSettings, "abortSignal" | "headers">>;

export type AgentRunModelOverrides = JsonCallSettings & Pick<StreamTextOptions, "providerOptions">;

export type AgentRunOverrides = {
  system?: SystemModelMessage | SystemModelMessage[];
  model?: AgentRunModelOverrides;
};

export type AgentRunEventInput = {
  /** Shorthand for a single user text message. */
  input: string;
  events?: never;
} | {
  /** Full-fidelity event list for multimodal content or tool responses. */
  events: [ModelMessage, ...ModelMessage[]];
  input?: never;
};

/**
 * Resolves a run's events from either the explicit `events` list or the `input`
 * string shorthand, matching the core direct API's event contract.
 */
export function resolveRunEvents(input: AgentRunEventInput): ModelMessage[] {
  if (input.events && input.input !== undefined) {
    throw new Error("Run input accepts either `input` or `events`, not both");
  }
  if (input.events && input.events.length > 0) return input.events;
  if (typeof input.input === "string") {
    return [{ role: "user", content: [{ type: "text", text: input.input }] }];
  }

  throw new Error("Run input requires `input` (string) or a non-empty `events` array");
}
