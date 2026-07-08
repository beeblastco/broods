/**
 * Account-owned code hook upload validation for Convex config-plane sync.
 * Mirrors core's account hook upload contract without requiring the Node runtime.
 */

import { inferAccountToolRuntime } from "./accountTools";
import { isPlainObject } from "./objects";

export const AGENT_HOOK_EVENT_NAMES = [
    "agent.started",
    "agent.step.finished",
    "agent.finished",
    "agent.failed",
    "agent.approval.required",
    "tool.call.started",
    "tool.call.finished",
    "tool.result",
    "subagent.task.started",
    "subagent.task.finished",
    "channel.message.received",
    "channel.message.sending",
] as const;

export type AgentHookEventName = (typeof AGENT_HOOK_EVENT_NAMES)[number];

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

export interface RequiredAccountHookUpload {
    name: string;
    description?: string;
    events: AgentHookEventName[];
    bundle: string;
    sha256: string;
}

const HOOK_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const MAX_BUNDLE_BYTES = 512 * 1024;

/**
 * Normalize and validate a CLI/API-supplied code hook upload.
 * @param input upload object from the CLI manifest or HTTP body
 * @param options whether all creation fields, including bundle, are required
 * @returns normalized fields with bundle sha256 when a bundle is present
 */
export async function normalizeAccountHookUpload(
    input: unknown,
    options: { requireBundle: true },
): Promise<RequiredAccountHookUpload>;
export async function normalizeAccountHookUpload(
    input: unknown,
    options: { requireBundle: false },
): Promise<NormalizedAccountHookUpload>;
export async function normalizeAccountHookUpload(
    input: unknown,
    options: { requireBundle: boolean },
): Promise<NormalizedAccountHookUpload> {
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
        result.sha256 = await sha256Hex(result.bundle);
    } else if (options.requireBundle) {
        throw new Error("hook.bundle is required");
    }

    return result as NormalizedAccountHookUpload;
}

/**
 * Build the S3 object key used for an account hook bundle.
 * @param accountId account id owning the hook
 * @param sha256 hex sha256 of the bundle contents
 * @returns stable S3 key for the bundle object
 */
export function accountHookBundleStorageKey(accountId: string, sha256: string): string {
    return `account-hooks/${encodeURIComponent(accountId)}/bundles/${sha256}.mjs`;
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
    if (new TextEncoder().encode(value).byteLength > MAX_BUNDLE_BYTES) {
        throw new Error(`hook.bundle must be ${MAX_BUNDLE_BYTES} bytes or smaller`);
    }
    if (inferAccountToolRuntime(value) === "sandbox") {
        throw new Error("hook.bundle must be isolate-safe: node: imports, bare package imports, require(), process, and __dirname are not allowed");
    }

    return value;
}

async function sha256Hex(value: string): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));

    return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
