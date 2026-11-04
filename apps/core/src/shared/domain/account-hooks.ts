import type { AgentHookEventName } from "./agent-config.ts";

export type AccountHookStatus = "active" | "deleted";

export interface AccountHookRecord {
  accountId: string;
  hookId: string;
  name: string;
  description?: string;
  events: AgentHookEventName[];
  bundleStorageKey: string;
  sha256: string;
  status: AccountHookStatus;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}
