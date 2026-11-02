import type { AgentConfig } from "./agent-config.ts";

export interface AgentRecord {
  accountId: string;
  agentId: string;
  name: string;
  description?: string;
  config: AgentConfig;
  /** Runtime-key requests must carry a signed user token. */
  requireUserToken?: boolean;
  createdAt: string;
  updatedAt: string;
}
