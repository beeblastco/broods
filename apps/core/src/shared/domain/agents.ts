/**
 * Agent records as core reads them from storage. Agent CRUD and its input
 * validation live in the config plane (packages/convex/config/routes/agents.ts).
 */

import type { AgentConfig } from "./agent-config.ts";

export interface AgentRecord {
  accountId: string;
  agentId: string;
  name: string;
  description?: string;
  config: AgentConfig;
  /**
   * A runtime-key request must carry a signed user token. Set on every agent
   * created since the token shipped; unset on an older one until its owner
   * turns it on.
   */
  requireUserToken?: boolean;
  createdAt: string;
  updatedAt: string;
}
