/**
 * User code hook execution.
 * Loads an uploaded accountHooks bundle, runs the handler for a fired event in
 * the V8 isolate pool, and returns the validated, field-scoped mutation the
 * caller folds into harness state. Hooks are non-fatal: a throw or timeout logs
 * and yields no mutation, so the agent run is never broken. Dispatch across
 * hooks lives in hook-dispatcher.ts; this file owns only "run one hook,
 * sanitize its return".
 */

import type { JSONValue } from "ai";
import { createHash } from "node:crypto";
import type { AccountHookRecord } from "../shared/domain/account-hooks.ts";
import type {
  AgentHookEventName,
  HookAgentConfig,
} from "../shared/domain/agent-config.ts";
import { logError } from "../shared/log.ts";
import { isPlainObject } from "../shared/object.ts";
import { readS3Bytes } from "../shared/s3.ts";
import { streamIsolatePayload } from "./isolate/executor.ts";
import { toolBundlesBucket } from "./frames.ts";

// A hook may return at most this many bytes more than the event it was handed,
// so a runaway hook cannot balloon the conversation or a channel payload while
// an agent.started hook that rewrites a long conversation in place still fits.
const MAX_HOOK_RESULT_BYTES = 128 * 1024;

// ctx.state round-trips through the isolate on every hook call, so cap it too; a
// hook that grows state past this keeps the prior state instead.
const MAX_HOOK_STATE_BYTES = 128 * 1024;

// The only fields a hook may mutate at each event. Anything else in the return
// is dropped; events not listed here are observe-only (return ignored). Pick's
// key constraint holds every key to a real AgentHookEventName.
const HOOK_MUTABLE_FIELDS: Pick<
  Record<AgentHookEventName, readonly string[]>,
  | "agent.started"
  | "agent.finished"
  | "agent.approval.required"
  | "tool.call.started"
  | "tool.result"
  | "subagent.task.finished"
  | "channel.message.received"
  | "channel.message.sending"
> = {
  "agent.started": ["system", "messages"],
  "agent.finished": ["output"],
  "agent.approval.required": ["approve"],
  "tool.call.started": ["decision", "args", "denyReason"],
  "tool.result": ["output"],
  "subagent.task.finished": ["visibleResult"],
  // `metadata` is opaque per-message data (persisted on the stored-event
  // envelope, projected back onto agent.started payload messages).
  "channel.message.received": ["drop", "text", "metadata"],
  "channel.message.sending": ["drop", "text"],
};

// A hook bundle never changes under its sha256 and hooks fire several times a
// turn, so the encoded source is kept instead of read from S3 at every fire.
// Past this many base64 characters (one byte each) the least recently used
// goes first: at most six 1 MB bundles, the upload cap, stay resident.
const HOOK_BUNDLE_CACHE_BYTES = 8 * 1024 * 1024;
const hookBundles = new Map<
  string,
  { source: Promise<string>; bytes: number }
>();
let hookBundleBytes = 0;

export type HookMutableEvent = keyof typeof HOOK_MUTABLE_FIELDS;

export interface RunCodeHookParams {
  accountId: string;
  record: AccountHookRecord;
  event: AgentHookEventName;
  /** Event data handed to the hook as its second argument (JSON-serializable). */
  payload: Record<string, JSONValue | undefined>;
  /** The allow-listed agent config, exposed to the hook as ctx.config. */
  config: HookAgentConfig;
  /** Mutable per-run scratchpad exposed to the hook as ctx.state. */
  state: Record<string, unknown>;
}

export interface CodeHookOutcome {
  /** The sanitized, field-scoped mutation, or undefined when there is none. */
  mutation: Record<string, unknown> | undefined;
  /** The run state after the hook ran (unchanged on decline/error/timeout). */
  state: Record<string, unknown>;
}

/** Whether a hook's return is folded back at this event, rather than ignored. */
export function isHookMutableEvent(
  event: AgentHookEventName,
): event is HookMutableEvent {
  return event in HOOK_MUTABLE_FIELDS;
}

/**
 * Run one hook bundle for one event and return its sanitized mutation plus the
 * (possibly hook-mutated) run state. Never throws: on decline/error/timeout the
 * mutation is undefined and the incoming state is echoed back unchanged.
 */
export async function runCodeHook(
  params: RunCodeHookParams,
): Promise<CodeHookOutcome> {
  const { accountId, record, event } = params;
  const incomingState = params.state;
  try {
    const payload = await createHookRunnerPayload(params);
    // Hook mode always yields { result, state }. The runner reads ctx.state
    // back out so the host can thread it into the next fire-point.
    const raw = (await runForResult(accountId, payload)) as
      | { result?: unknown; state?: unknown }
      | undefined;

    return {
      mutation: sanitizeHookResult(
        event,
        raw?.result,
        Buffer.byteLength(JSON.stringify(params.payload), "utf8"),
      ),
      state: sanitizeHookState(raw?.state, incomingState),
    };
  } catch (error) {
    logError("Code hook execution failed", {
      accountId: accountId,
      hookId: record.hookId,
      hookName: record.name,
      event: event,
      error: error instanceof Error ? error.message : String(error),
    });

    return { mutation: undefined, state: incomingState };
  }
}

/**
 * Keep only the fields a hook is allowed to mutate at this event, after a size
 * cap of `inputBytes` (the serialized event the hook received) plus
 * MAX_HOOK_RESULT_BYTES. Returns undefined when the event is observe-only, the
 * return is not an object, or no mutable field is present.
 */
export function sanitizeHookResult(
  event: AgentHookEventName,
  raw: unknown,
  inputBytes = 0,
): Record<string, unknown> | undefined {
  if (!isHookMutableEvent(event)) return undefined;
  if (!isPlainObject(raw)) return undefined;

  const serialized = safeStringify(raw);
  if (serialized === undefined) return undefined;
  const limit = inputBytes + MAX_HOOK_RESULT_BYTES;
  if (Buffer.byteLength(serialized, "utf8") > limit) {
    throw new Error(`code hook return exceeds ${limit} bytes`);
  }

  const allowed = HOOK_MUTABLE_FIELDS[event];
  const result: Record<string, unknown> = {};
  for (const key of allowed) {
    if (raw[key] !== undefined) result[key] = raw[key];
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Builds the isolate runner payload around the hook bundle, read from S3 once
 * per account, storage key and sha256 while it stays in the cache.
 */
async function createHookRunnerPayload(
  params: RunCodeHookParams,
): Promise<Record<string, unknown>> {
  const { record, event, payload, config } = params;
  const key = `${record.accountId}:${record.bundleStorageKey}:${record.sha256}`;
  const cached = hookBundles.get(key);
  // Deleting and setting again keeps the Map's order least recently used first.
  hookBundles.delete(key);
  const entry = cached ?? {
    source: readS3Bytes(toolBundlesBucket(), record.bundleStorageKey).then(
      (bytes) => {
        // The runner checks the sha256 again; this keeps a bad read out of the cache.
        if (createHash("sha256").update(bytes).digest("hex") !== record.sha256)
          throw new Error("hook bundle does not match its sha256");

        return Buffer.from(bytes).toString("base64");
      },
    ),
    bytes: 0,
  };
  hookBundles.set(key, entry);
  if (!cached) {
    // Concurrent fires share this one read. A failed read is dropped so the
    // next fire reads again; a finished one counts against the budget.
    entry.source.then(
      (source) => {
        if (hookBundles.get(key) !== entry) return;
        entry.bytes = source.length;
        hookBundleBytes += source.length;
        for (const [oldKey, old] of hookBundles) {
          if (hookBundleBytes <= HOOK_BUNDLE_CACHE_BYTES) break;
          hookBundles.delete(oldKey);
          hookBundleBytes -= old.bytes;
        }
      },
      () => {
        if (hookBundles.get(key) === entry) hookBundles.delete(key);
      },
    );
  }

  return {
    bundleSourceB64: await entry.source,
    expectedSha256: record.sha256,
    toolName: record.name,
    hookEvent: event,
    input: payload,
    config: config,
    state: params.state,
  };
}

/** Drains one isolate hook run for `runCodeHook` and keeps the last value it yielded. */
async function runForResult(
  accountId: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  // A hook returns a single value; the isolate yields chunks only for the
  // async-iterable tool path, so the last yielded value is the handler's return.
  let result: unknown;
  for await (const value of streamIsolatePayload(accountId, payload)) {
    result = value;
  }

  return result;
}

/** JSON.stringify that returns undefined instead of throwing on cycles or BigInt. */
function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/**
 * Keep the hook's mutated run state when it is a valid, size-bounded plain
 * object; otherwise fall back to the state the hook was given (a bad/oversized
 * state must not silently replace what earlier hooks accumulated).
 */
function sanitizeHookState(
  state: unknown,
  fallback: Record<string, unknown>,
): Record<string, unknown> {
  if (!isPlainObject(state)) return fallback;
  if (Object.keys(state).length === 0) return state;

  const serialized = safeStringify(state);
  if (
    serialized === undefined ||
    Buffer.byteLength(serialized, "utf8") > MAX_HOOK_STATE_BYTES
  ) {
    return fallback;
  }

  return state;
}
