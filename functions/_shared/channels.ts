import type { UserContent } from "ai";

export interface ChannelActions {
  sendText(text: string): Promise<void>;
  sendTyping(): Promise<void>;
  reactToMessage(): Promise<void>;
}

export interface InboundMessage {
  eventId: string;
  conversationKey: string;
  channelName: string;
  content: UserContent;
  source: Record<string, unknown>;
}

export interface ChannelAdapter {
  readonly name: string;
  authenticate(headers: Record<string, string>, body: string): boolean;
  parse(body: string): InboundMessage | null;
  actions(msg: InboundMessage): ChannelActions;
}

export function extractText(content: UserContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}
