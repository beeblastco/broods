/**
 * Shared WebSocket wire message contracts used by the SDK client and gateway.
 */

import type { AgentRunEventInput, AgentRunOverrides } from "./run-input.ts";
import type { AgentStreamPart } from "./stream.ts";

export type IngressMode = "reject" | "followup" | "collect" | "steer";
export type IngressStatus =
  | "accepted"
  | "queued"
  | "applied"
  | "processing"
  | "completed"
  | "failed"
  | "expired";

export type WebSocketStreamMessage =
  | AgentStreamPart
  | {
      type: string;
      [key: string]: unknown;
    };

export type WebSocketServerMessage =
  | { type: "meta"; sessionId: string; taskId: string }
  | {
      type: "ack";
      requestId: string;
      eventId: string;
      status: IngressStatus;
      statusUrl?: string;
    }
  | {
      type: "status";
      requestId: string;
      eventId: string;
      status: IngressStatus | "not_found";
      requestedMode?: IngressMode;
      appliedMode?: IngressMode;
      appliedToEventId?: string;
      statusUrl?: string;
      error?: string;
    }
  | {
      type: "attached";
      requestId: string;
      eventId: string;
      status: IngressStatus;
      replayFromCursor?: string;
      replayThroughCursor?: string;
      statusUrl?: string;
    }
  | {
      type: "replay_unavailable";
      requestId: string;
      eventId: string;
      status: IngressStatus | "not_found";
      statusUrl?: string;
    }
  | WebSocketOutputMessage
  | WebSocketStreamMessage;

/**
 * Durable-stream envelope around one stream part. The SDK unwraps `data` for
 * handlers and surfaces the envelope itself through `onOutput` so clients can
 * persist `cursor` for attach-based resume.
 */
export type WebSocketOutputMessage = {
  type: "output";
  eventId: string;
  cursor: string;
  replay: boolean;
  data: WebSocketStreamMessage;
};

export type WebSocketClientExecuteMessage = {
  type: "execute";
  agentId: string;
  sessionId?: string;
  eventId?: string;
  mode?: IngressMode;
  idempotencyKey?: string;
} & AgentRunEventInput &
  AgentRunOverrides;

export type WebSocketClientControlMessage = {
  type: "control";
  requestId: string;
  eventId: string;
  idempotencyKey?: string;
  mode: IngressMode;
} & AgentRunEventInput;

export type WebSocketClientAttachMessage = {
  type: "attach";
  requestId: string;
  agentId: string;
  conversationKey: string;
  eventId: string;
  afterCursor?: string;
};

export type WebSocketClientCancelMessage = { type: "cancel" };

export type WebSocketClientMessage =
  | WebSocketClientExecuteMessage
  | WebSocketClientControlMessage
  | WebSocketClientAttachMessage
  | WebSocketClientCancelMessage;
