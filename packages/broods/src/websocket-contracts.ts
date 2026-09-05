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
  | "awaiting_approval"
  | "awaiting_input"
  | "completed"
  | "failed"
  | "expired";

/** One open `ask_questions` prompt while a run is `awaiting_input`. */
export interface PendingQuestion {
  /** Pass back as `answers[].statusId`. */
  statusId: string;
  /** After this the prompt settles as no_answer. */
  answerBy: string;
  questions: {
    id: string;
    header: string;
    question: string;
    options: { label: string; description?: string }[];
    allowFreeText?: boolean;
  }[];
}

export type WebSocketStreamMessage =
  | AgentStreamPart
  | { type: "question-request"; questions: PendingQuestion[] }
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
  /** Defaults to "steer": join the live run at its next step boundary. */
  mode?: IngressMode;
  idempotencyKey?: string;
} & AgentRunEventInput &
  AgentRunOverrides;

export type WebSocketClientControlMessage = {
  type: "control";
  requestId: string;
  eventId: string;
  idempotencyKey?: string;
  /** Defaults to "steer": join the live run at its next step boundary. */
  mode?: IngressMode;
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
