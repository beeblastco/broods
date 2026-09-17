/**
 * Agent records as core reads them from storage. Agent CRUD and its input
 * validation live in the config plane (packages/convex/config/routes/agents.ts).
 */

import type { AgentConfig } from "./agent-config.ts";

export type AgentStatus = "active" | "disabled";

export interface AgentRecord {
  accountId: string;
  agentId: string;
  name: string;
  description?: string;
  status: AgentStatus;
  config: AgentConfig;
  createdAt: string;
  updatedAt: string;
}
