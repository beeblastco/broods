/**
 * Wire types for the public account-manage and harness APIs. These mirror
 * the deployed API contract (docs/api-reference/openapi.yaml is the source
 * of truth); they are intentionally independent of the Lambda internals so
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

export interface AsyncStatus {
  status: "processing" | "awaiting_approval" | "completed" | "failed" | "not_found";
  response?: unknown;
  error?: string;
  approvals?: ToolApprovalSummary[];
}

export interface AsyncRequestAccepted {
  statusUrl: string;
  statusId: string;
  eventId: string;
  agentId: string;
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

export interface CustomTool {
  accountId: string;
  toolId: string;
  name: string;
  description: string;
  sha256: string;
}
