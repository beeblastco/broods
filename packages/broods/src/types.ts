// Mirrors apps/docs/docs/api-reference/openapi.yaml; never import core's runtime types.

import type { ModelMessage } from "ai";
import type { CronLastStatus, CronStatus } from "./contracts.ts";
import type { PendingQuestion } from "./websocket-contracts.ts";

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

export interface AsyncRequestAccepted {
  statusUrl: string;
  runId: string;
  eventId: string;
  agentId: string;
  status?: "accepted" | "queued" | "applied" | "processing";
  requestedMode?: "reject" | "followup" | "collect" | "steer";
}

/** The 202 for `answer`. When the conversation resumed, `eventId` and `runId` name that turn. */
export interface AnswersAccepted {
  status: "accepted";
  resultId: string;
  eventId?: string;
  /** For `waitForAsyncStatus`. Set only when a turn started or queued: the last answer's. */
  runId?: string;
  statusUrl?: string;
  invoked?: boolean;
  /** `statusId`s already answered, skipped because another answer landed. */
  alreadyAnswered?: string[];
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
  /** Absent only on the `not_found` the SDK returns for a 404. */
  runId?: string;
  eventId?: string;
  agentId?: string;
  conversationKey?: string;
  requestedMode?: "reject" | "followup" | "collect" | "steer";
  appliedMode?: "reject" | "followup" | "collect" | "steer";
  appliedToEventId?: string;
  result?: unknown;
  response?: unknown;
  error?: string;
  stoppedByUser?: boolean;
  approvals?: ToolApprovalSummary[];
  questions?: PendingQuestion[];
  /** ISO 8601 time the run was accepted. */
  createdAt?: string;
  /** ISO 8601 time the run's status last moved. */
  lastUpdatedAt?: string;
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

export interface Sandbox {
  sandboxId: string;
  name: string;
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

export interface ToolApprovalSummary {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface Workspace {
  workspaceId: string;
  name: string;
}
