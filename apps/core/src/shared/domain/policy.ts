// OPA makes the runtime decision from these same document and input shapes.

import type {
  PolicyAction,
  PolicyDocument,
} from "@broods/convex/model/policyRules";
import type { Principal } from "./principal.ts";

export type {
  PolicyAction,
  PolicyDocument,
} from "@broods/convex/model/policyRules";

export type PolicyMode = "enforce" | "audit";

export interface PolicyRecord {
  accountId: string;
  policyId: string;
  name: string;
  description?: string;
  document: PolicyDocument;
  status: "active" | "deleted";
  createdAt: string;
  updatedAt: string;
}

export interface PolicyDecisionInput {
  action: PolicyAction;
  accountId?: string;
  project?: string;
  stage?: string;
  endpointId?: string;
  agentId?: string;
  principal?: Principal;
  conversationKey?: string;
  delivery?: string;
  /** Adapter name, e.g. "slack". The place is `channelId`, not this. */
  channel?: string;
  channelId?: string;
  threadId?: string;
  userId?: string;
  userName?: string;
  userRoles?: string[];
  toolName?: string;
  mcpId?: string;
  workspaceId?: string;
  workspaceName?: string;
  filePath?: string;
  /** Set on grep and glob: `filePath` is the directory searched, "" for the root. */
  searchRoot?: boolean;
  subagentId?: string;
  skillPath?: string;
  sandboxPermissionMode?: string;
  tool?: {
    input?: Record<string, unknown>;
    inputKeys?: string[];
    inputPreview?: string;
  };
}

export interface PolicyDecision {
  allowed: boolean;
  mode: PolicyMode;
  reason: string;
  matchedRuleIds: string[];
  auditedRuleIds: string[];
}
