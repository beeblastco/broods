/**
 * Wire types for the public account-manage and harness APIs. These mirror
 * the deployed API contract (docs/api-reference/openapi.yaml is the source
 * of truth); they are intentionally independent of the runtime internals so
 * the SDK keeps working when the runtime is ported.
 */

import type { ModelMessage } from "ai";
import type { CronLastStatus, CronStatus } from "./contracts.ts";

export interface Account {
  account: {
    accountId: string;
    username: string;
  };
  secret: string;
}

export interface Agent {
  accountId: string;
  agentId: string;
  name: string;
}

export interface Sandbox {
  sandboxId: string;
  name: string;
}

export interface Workspace {
  workspaceId: string;
  name: string;
}

/** A tool call held for user approval by an `ask`-mode sandbox. */
export interface ToolApprovalSummary {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
}

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
    multiSelect?: boolean;
    allowFreeText?: boolean;
  }[];
}

export interface AsyncStatus {
  status:
    | "accepted"
    | "queued"
    | "applied"
    | "processing"
    | "awaiting_approval"
    | "awaiting_input"
    | "completed"
    | "failed"
    | "expired"
    | "not_found";
  requestedMode?: "reject" | "followup" | "collect" | "steer";
  appliedMode?: "reject" | "followup" | "collect" | "steer";
  appliedToEventId?: string;
  result?: unknown;
  response?: unknown;
  error?: string;
  /** True when `failed` was a deliberate /stop, not a fault. */
  stoppedByUser?: boolean;
  approvals?: ToolApprovalSummary[];
  questions?: PendingQuestion[];
}

export interface AsyncRequestAccepted {
  statusUrl: string;
  statusId: string;
  eventId: string;
  agentId: string;
  status?: "accepted" | "queued" | "applied" | "processing";
  requestedMode?: "reject" | "followup" | "collect" | "steer";
}

export interface Cron {
  accountId: string;
  cronId: string;
  name: string;
  description?: string;
  agentId: string;
  events: ModelMessage[];
  conversationKey?: string;
  scheduleExpression: string;
  timezone?: string;
  status: CronStatus;
  createdAt: string;
  updatedAt: string;
  lastInvokedAt?: string;
  lastStatus?: CronLastStatus;
  lastError?: string;
}

export interface CronRun {
  accountId: string;
  cronId: string;
  runId: string;
  eventId: string;
  conversationKey: string;
  status: CronLastStatus;
  result?: unknown;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

export interface Skill {
  path: string;
  name: string;
  description: string;
  files?: Array<{
    path: string;
    size?: number;
  }>;
}
