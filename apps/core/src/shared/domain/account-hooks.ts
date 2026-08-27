/**
 * Account-owned code hook record contracts. Bundle bytes live in S3; upload
 * validation is the config plane's (packages/convex/model/accountHooks.ts).
 * Hooks run inline in the harness hot path, so they are isolate-only: bundles
 * that need node/npm are rejected at upload. The runner in
 * harness/hook-runner.ts loads a bundle and invokes its per-event handler in
 * the V8 isolate pool.
 */

import type { AgentHookEventName } from "./agent-config.ts";

export type AccountHookStatus = "active" | "deleted";

export interface AccountHookRecord {
  accountId: string;
  hookId: string;
  name: string;
  description?: string;
  /** Events whose handlers this bundle exports (declared + validated at upload). */
  events: AgentHookEventName[];
  bundleStorageKey: string;
  sha256: string;
  status: AccountHookStatus;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface PublicAccountHookRecord {
  accountId: string;
  hookId: string;
  name: string;
  description?: string;
  events: AgentHookEventName[];
  sha256: string;
  status: AccountHookStatus;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}
