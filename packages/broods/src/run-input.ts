import type {
  LanguageModelCallOptions,
  ModelMessage,
  RequestOptions,
  SystemModelMessage,
  streamText,
} from "ai";

type StreamTextOptions = Parameters<typeof streamText>[0];
type JsonCallSettings = Partial<
  LanguageModelCallOptions & Pick<RequestOptions, "maxRetries" | "timeout">
>;

export type AgentRunModelOverrides = JsonCallSettings &
  Pick<StreamTextOptions, "providerOptions">;

export type AgentRunOverrides = {
  system?: SystemModelMessage | SystemModelMessage[];
  model?: AgentRunModelOverrides;
};

export type AgentRunEventInput =
  | {
      input: string;
      events?: never;
      answers?: never;
    }
  | {
      events: [ModelMessage, ...ModelMessage[]];
      input?: never;
      answers?: never;
    };

export function resolveRunEvents(input: AgentRunEventInput): ModelMessage[] {
  if (input.events && input.input !== undefined) {
    throw new Error("Run input accepts either `input` or `events`, not both");
  }
  if (input.events && input.events.length > 0) return input.events;
  if (typeof input.input === "string") {
    return [{ role: "user", content: [{ type: "text", text: input.input }] }];
  }

  throw new Error(
    "Run input requires `input` (string) or a non-empty `events` array",
  );
}
