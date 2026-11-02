import type { JSONValue } from "ai";
import { createHash } from "node:crypto";
import type { AccountHookRecord } from "../shared/domain/account-hooks.ts";
import type {
  AgentHookEventName,
  HookAgentConfig,
} from "../shared/domain/agent-config.ts";
import { logError } from "../shared/log.ts";
import { isPlainObject } from "@broods/convex/model/objects";
import { readS3Bytes } from "../shared/s3.ts";
import { streamIsolatePayload } from "./isolate/executor.ts";
import { toolBundlesBucket } from "./frames.ts";

// Over the size of the event the hook got, so rewriting a long conversation in place still fits.
const MAX_HOOK_RESULT_BYTES = 128 * 1024;
const MAX_HOOK_STATE_BYTES = 128 * 1024;

// Events not listed are observe-only; any other field a hook returns is dropped.
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
  "channel.message.received": ["drop", "text", "metadata"],
  "channel.message.sending": ["drop", "text"],
};

// Keyed by sha256, so an entry never goes stale; LRU-evicted past ~six 1 MB bundles.
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
  payload: Record<string, JSONValue | undefined>;
  config: HookAgentConfig;
  state: Record<string, unknown>;
}

export interface CodeHookOutcome {
  mutation: Record<string, unknown> | undefined;
  state: Record<string, unknown>;
}

export function isHookMutableEvent(
  event: AgentHookEventName,
): event is HookMutableEvent {
  return event in HOOK_MUTABLE_FIELDS;
}

/** Never throws: a failing hook logs and yields no mutation, so it cannot break the run. */
export async function runCodeHook(
  params: RunCodeHookParams,
): Promise<CodeHookOutcome> {
  const { accountId, record, event } = params;
  const incomingState = params.state;
  try {
    const payload = await createHookRunnerPayload(params);
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
    // Concurrent fires share this read; a failed one leaves the cache so the next fire retries.
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

async function runForResult(
  accountId: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  // Only async-iterable tools yield chunks, so a hook's last yielded value is its return.
  let result: unknown;
  for await (const value of streamIsolatePayload(accountId, payload)) {
    result = value;
  }

  return result;
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

// A bad or oversized state must not replace what earlier hooks accumulated.
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
