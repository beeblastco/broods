/**
 * Account-owned code hook metadata and upload validation.
 * Bundle bytes live in S3; this file owns the persisted record contract. Hooks
 * run inline in the harness hot path, so they are isolate-only: bundles that
 * need node/npm are rejected at upload. The runner in harness/hook-runner.ts
 * loads a bundle and invokes its per-event handler in the V8 isolate pool.
 */

import { createHash } from "node:crypto";
import { isPlainObject } from "../object.ts";
import { AGENT_HOOK_EVENT_NAMES, type AgentHookEventName } from "./agent-config.ts";
import { inferAccountToolRuntime } from "./account-tools.ts";

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

export interface CreateAccountHookInput {
  name: string;
  description?: string;
  events: AgentHookEventName[];
  bundleStorageKey: string;
  sha256: string;
}

export interface UpdateAccountHookInput {
  name?: string;
  description?: string | null;
  events?: AgentHookEventName[];
  bundleStorageKey?: string;
  sha256?: string;
}

export interface AccountHookUploadInput {
  name?: unknown;
  description?: unknown;
  events?: unknown;
  bundle?: unknown;
}

export interface NormalizedAccountHookUpload {
  name?: string;
  description?: string;
  events?: AgentHookEventName[];
  bundle?: string;
  sha256?: string;
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

const HOOK_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const MAX_BUNDLE_BYTES = 512 * 1024;

export function normalizeAccountHookUpload(input: unknown, options: { requireBundle: boolean }): NormalizedAccountHookUpload {
  if (!isPlainObject(input)) {
    throw new Error("hook upload body must be an object");
  }

  const value = input as AccountHookUploadInput;
  const result: Partial<NormalizedAccountHookUpload> = {};

  if (value.name !== undefined) {
    result.name = normalizeHookName(value.name);
  } else if (options.requireBundle) {
    throw new Error("hook.name is required");
  }

  if (value.description !== undefined) {
    result.description = normalizeDescription(value.description);
  }

  if (value.events !== undefined) {
    result.events = normalizeEvents(value.events);
  } else if (options.requireBundle) {
    throw new Error("hook.events is required");
  }

  if (value.bundle !== undefined) {
    result.bundle = normalizeBundle(value.bundle);
    result.sha256 = sha256Hex(result.bundle);
  } else if (options.requireBundle) {
    throw new Error("hook.bundle is required");
  }

  return result as NormalizedAccountHookUpload;
}

export function normalizeCreateAccountHookInput(input: CreateAccountHookInput): CreateAccountHookInput {
  return {
    name: normalizeHookName(input.name),
    ...(input.description !== undefined ? { description: normalizeDescription(input.description) } : {}),
    events: normalizeEvents(input.events),
    bundleStorageKey: normalizeStorageKey(input.bundleStorageKey),
    sha256: normalizeSha256(input.sha256),
  };
}

export function normalizeUpdateAccountHookInput(input: UpdateAccountHookInput): UpdateAccountHookInput {
  const patch: UpdateAccountHookInput = {};
  if (input.name !== undefined) patch.name = normalizeHookName(input.name);
  if (input.description !== undefined) {
    patch.description = input.description === null ? null : normalizeDescription(input.description);
  }
  if (input.events !== undefined) patch.events = normalizeEvents(input.events);
  if (input.bundleStorageKey !== undefined) patch.bundleStorageKey = normalizeStorageKey(input.bundleStorageKey);
  if (input.sha256 !== undefined) patch.sha256 = normalizeSha256(input.sha256);
  return patch;
}

export function accountHookBundleStorageKey(accountId: string, sha256: string): string {
  return `account-hooks/${encodeURIComponent(accountId)}/bundles/${sha256}.mjs`;
}

export function toPublicAccountHook(record: AccountHookRecord): PublicAccountHookRecord {
  return {
    accountId: record.accountId,
    hookId: record.hookId,
    name: record.name,
    ...(record.description !== undefined ? { description: record.description } : {}),
    events: record.events,
    sha256: record.sha256,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.deletedAt ? { deletedAt: record.deletedAt } : {}),
  };
}

function normalizeHookName(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("hook.name must be a non-empty string");
  }
  const name = value.trim();
  if (!HOOK_NAME_PATTERN.test(name)) {
    throw new Error("hook.name must start with a letter or underscore and contain only letters, numbers, underscores, or hyphens");
  }
  return name;
}

function normalizeDescription(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("hook.description must be a non-empty string");
  }
  return value.trim();
}

function normalizeEvents(value: unknown): AgentHookEventName[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("hook.events must be a non-empty array");
  }
  const events: AgentHookEventName[] = [];
  for (const event of value) {
    if (typeof event !== "string" || !AGENT_HOOK_EVENT_NAMES.includes(event as AgentHookEventName)) {
      throw new Error(`hook.events must contain only: ${AGENT_HOOK_EVENT_NAMES.join(", ")}`);
    }
    if (!events.includes(event as AgentHookEventName)) {
      events.push(event as AgentHookEventName);
    }
  }
  return events;
}

function normalizeBundle(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("hook.bundle must be a non-empty string");
  }
  if (Buffer.byteLength(value, "utf8") > MAX_BUNDLE_BYTES) {
    throw new Error(`hook.bundle must be ${MAX_BUNDLE_BYTES} bytes or smaller`);
  }
  // Hooks run inline in the agent hot path, so they must be isolate-pure. Reuse
  // the custom-tool tier scan: anything that would need the sandbox tier
  // (node:/npm/require/process) is rejected outright.
  if (inferAccountToolRuntime(value) === "sandbox") {
    throw new Error("hook.bundle must be isolate-safe: node: imports, bare package imports, require(), process, and __dirname are not allowed");
  }
  return value;
}

function normalizeStorageKey(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("hook.bundleStorageKey must be a non-empty string");
  }
  return value;
}

function normalizeSha256(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("hook.sha256 must be a hex sha256");
  }
  return value;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
