/**
 * Shared WebSocket wire message contracts used by the SDK client and gateway.
 */

import type { AgentRunEventInput, AgentRunOverrides } from "./run-input.ts";
import type { AgentStreamPart } from "./stream.ts";

export type WebSocketStreamMessage = AgentStreamPart | {
  type: string;
  [key: string]: unknown;
};

export type WebSocketServerMessage =
  | { type: "meta"; sessionId: string; taskId: string }
  | WebSocketStreamMessage;

export type WebSocketClientExecuteMessage = {
  type: "execute";
  agentId: string;
  sessionId?: string;
  eventId?: string;
} & AgentRunEventInput & AgentRunOverrides;

export type WebSocketClientCancelMessage = { type: "cancel" };

export type WebSocketClientMessage = WebSocketClientExecuteMessage | WebSocketClientCancelMessage;
