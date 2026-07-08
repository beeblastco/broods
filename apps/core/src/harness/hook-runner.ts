/**
 * User code hook execution.
 * Loads an uploaded accountHooks bundle, runs the handler for a fired event in
 * the V8 isolate pool (same hardened runner as custom tools), and returns the
 * validated, field-scoped mutation the caller folds into harness state. Hooks
 * are non-fatal: a throw/timeout logs and yields no mutation so the agent run is
 * never broken. Fire-point wiring lives in harness.ts / integrations.ts; this
 * file owns only "run one hook, sanitize its return".
 */

import type { JSONValue } from "ai";
import { logError } from "../shared/log.ts";
import { readS3Bytes } from "../shared/s3.ts";
import type { AgentHookEventName } from "../shared/storage/agent-config.ts";
import type { AccountHookRecord } from "../shared/storage/account-hooks.ts";
import { streamIsolatePayload } from "./tools/isolate-executor.ts";
import { toolBundlesBucket } from "./tools/custom-tool-executor.ts";

// A hook's return is capped before it re-enters the harness so a runaway hook
// cannot balloon the conversation or a channel payload.
const MAX_HOOK_RESULT_BYTES = 128 * 1024;

// The only fields a hook may mutate at each event. Anything else in the return
// is dropped; events not listed here are observe-only (return ignored).
const HOOK_MUTABLE_FIELDS = {
  "agent.started": ["system", "messages"],
  "agent.finished": ["output"],
  "agent.approval.required": ["approve"],
  "tool.call.started": ["decision", "args", "denyReason"],
  "tool.result": ["output"],
  "subagent.task.finished": ["visibleResult"],
  "channel.message.received": ["drop", "text", "metadata"],
  "channel.message.sending": ["drop", "text"],
} as const satisfies Partial<Record<AgentHookEventName, readonly string[]>>;

export type HookMutableEvent = keyof typeof HOOK_MUTABLE_FIELDS;

export function isHookMutableEvent(event: AgentHookEventName): event is HookMutableEvent {
  return event in HOOK_MUTABLE_FIELDS;
}

export interface RunCodeHookParams {
  accountId: string;
  record: AccountHookRecord;
  event: AgentHookEventName;
  /** Event data handed to the hook as its second argument (JSON-serializable). */
  payload: Record<string, JSONValue | undefined>;
  /** Optional config object exposed to the hook as ctx.config. */
  config?: Record<string, unknown>;
}

/**
 * Run one hook bundle for one event and return the sanitized mutation, or
 * undefined when the hook declines, errors, times out, or the event is
 * observe-only. Never throws.
 */
export async function runCodeHook(params: RunCodeHookParams): Promise<Record<string, unknown> | undefined> {
  const { accountId, record, event } = params;
  try {
    const payload = await createHookRunnerPayload(params);
    const raw = await runForResult(accountId, payload);
    return sanitizeHookResult(event, raw);
  } catch (error) {
    logError("Code hook execution failed", {
      accountId,
      hookId: record.hookId,
      hookName: record.name,
      event,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/** Loads the hook bundle from S3 and builds the isolate runner payload. */
async function createHookRunnerPayload(params: RunCodeHookParams): Promise<Record<string, unknown>> {
  const { record, event, payload, config } = params;
  const bytes = await readS3Bytes(toolBundlesBucket(), record.bundleStorageKey);
  return {
    bundleSourceB64: Buffer.from(bytes).toString("base64"),
    expectedSha256: record.sha256,
    toolName: record.name,
    hookEvent: event,
    input: payload,
    config: config ?? {},
  };
}

async function runForResult(accountId: string, payload: Record<string, unknown>): Promise<unknown> {
  // A hook returns a single value; the isolate yields chunks only for the async
  // -iterable tool path, so the last yielded value is the handler's return.
  let result: unknown;
  for await (const value of streamIsolatePayload(accountId, payload)) {
    result = value;
  }
  return result;
}

/**
 * Keep only the fields a hook is allowed to mutate at this event, after a size
 * cap. Returns undefined when the event is observe-only, the return is not an
 * object, or no mutable field is present.
 */
export function sanitizeHookResult(event: AgentHookEventName, raw: unknown): Record<string, unknown> | undefined {
  if (!isHookMutableEvent(event)) return undefined;
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return undefined;

  const serialized = safeStringify(raw);
  if (serialized === undefined) return undefined;
  if (Buffer.byteLength(serialized, "utf8") > MAX_HOOK_RESULT_BYTES) {
    throw new Error(`code hook return exceeds ${MAX_HOOK_RESULT_BYTES} bytes`);
  }

  const source = raw as Record<string, unknown>;
  const allowed = HOOK_MUTABLE_FIELDS[event];
  const result: Record<string, unknown> = {};
  for (const key of allowed) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}
