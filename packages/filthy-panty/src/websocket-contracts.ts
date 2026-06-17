/**
 * Shared WebSocket wire message contracts used by the SDK client and gateway.
 */

import type { AgentRunEventInput, AgentRunOverrides } from "./run-input.ts";

export type WebSocketServerMessage =
  | { type: "meta"; sessionId: string; taskId: string }
  | { type: "sse"; chunk: string }
  | { type: "continuation_delta"; delta: string }
  | { type: "subagent_delta"; sessionId: string; taskId: string; agentName?: string; delta: string }
  | {
    type: "subagent_activity";
    sessionId: string;
    taskId: string;
    agentName?: string;
    phase: "started" | "tool_call" | "tool_result";
    toolNames?: string[];
  }
  | { type: "subagent_result"; output: string }
  | { type: "done" }
  | { type: "error"; error: string; status?: number };

export type WebSocketClientExecuteMessage = {
  type: "execute";
  agentId: string;
  sessionId?: string;
  eventId?: string;
} & AgentRunEventInput & AgentRunOverrides;

export type WebSocketClientCancelMessage = { type: "cancel" };

export type WebSocketClientMessage = WebSocketClientExecuteMessage | WebSocketClientCancelMessage;
