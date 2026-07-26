/**
 * Per-run code hook dispatch.
 * Resolves an agent's configured code hooks (config.hooks.code) into an
 * event→records index, then runs the matching hooks at each fire-point and
 * merges their sanitized mutations. Per-event isolate execution + the
 * field-scoped mutation boundary live in hook-runner.ts; the fold into harness
 * state lives at the call sites (harness.ts / integrations.ts / subagents.ts).
 */

import type { JSONValue, ToolSet } from "ai";
import type { AccountHookRecord } from "../shared/domain/account-hooks.ts";
import type {
  AgentCodeHookConfig,
  AgentConfig,
  AgentHookEventName,
} from "../shared/domain/agent-config.ts";
import { isPlainObject } from "../shared/object.ts";
import { getStorage } from "../shared/storage.ts";
import { runCodeHook } from "./hook-runner.ts";
import type { AgentLifecycleEventPayload } from "./lifecycle.ts";
import { toLifecycleValue } from "./lifecycle.ts";
import { isAsyncIterable, isStreamingExecute } from "./tool-execute.ts";

export interface HookDispatcher {
  hasHooksFor(event: AgentHookEventName): boolean;
  /** Runs every hook registered for the event and returns the merged, field-scoped mutation. */
  runMutation(
    event: AgentHookEventName,
    payload: AgentLifecycleEventPayload,
  ): Promise<Record<string, unknown> | undefined>;
}

const NO_HOOKS: HookDispatcher = {
  hasHooksFor: () => false,
  async runMutation() {
    return undefined;
  },
};

/** Builds the dispatcher for one agent run, resolving referenced hook records once. */
export async function createAgentHookDispatcher(
  accountId: string | undefined,
  agentConfig: AgentConfig,
): Promise<HookDispatcher> {
  const refs = (agentConfig.hooks?.code ?? []).filter(
    (ref) => ref.enabled !== false,
  );
  if (!accountId || refs.length === 0) {
    return NO_HOOKS;
  }
  const records = await loadAgentHooks(accountId, refs);
  const index = buildEventIndex(refs, records);
  if (index.size === 0) {
    return NO_HOOKS;
  }
  return createHookDispatcher(accountId, index);
}

export function createHookDispatcher(
  accountId: string,
  index: Map<AgentHookEventName, AccountHookRecord[]>,
): HookDispatcher {
  // ctx.state: a mutable scratchpad shared by every hook in this run. Seeded
  // empty, threaded into each hook, and replaced with what the hook left behind
  // so a later fire-point sees what an earlier one stored.
  let runState: Record<string, unknown> = {};
  // Fire-points can overlap (parallel tool calls, a subagent finishing mid-step);
  // hook runs queue on this chain so no two read-modify-write runState at once.
  let queue: Promise<unknown> = Promise.resolve();
  return {
    hasHooksFor: (event) => index.has(event),
    async runMutation(event, payload) {
      const records = index.get(event);
      if (!records || records.length === 0) {
        return undefined;
      }
      const run = queue.then(async () => {
        // Hooks run in config order; later hooks' fields override earlier ones.
        let merged: Record<string, unknown> | undefined;
        for (const record of records) {
          const { mutation, state } = await runCodeHook({
            accountId,
            record,
            event,
            payload,
            state: runState,
          });
          runState = state;
          if (mutation) {
            merged = { ...(merged ?? {}), ...mutation };
          }
        }
        return merged;
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };
}

function buildEventIndex(
  refs: AgentCodeHookConfig[],
  records: AccountHookRecord[],
): Map<AgentHookEventName, AccountHookRecord[]> {
  const byId = new Map(records.map((record) => [record.hookId, record]));
  const index = new Map<AgentHookEventName, AccountHookRecord[]>();
  for (const ref of refs) {
    const record = byId.get(ref.hookId);
    if (!record || record.status !== "active") {
      continue;
    }
    // A ref may narrow the bundle's declared events; the effective set is the
    // intersection so a hook only fires for events it actually handles.
    const events = ref.events
      ? record.events.filter((event) => ref.events!.includes(event))
      : record.events;
    for (const event of events) {
      const list = index.get(event) ?? [];
      list.push(record);
      index.set(event, list);
    }
  }
  return index;
}

/**
 * Wraps every executable tool so a `tool.call.started` hook can deny or edit its
 * args before it runs and a `tool.result` hook can transform its output after.
 * Returns the ToolSet unchanged when no tool-scoped hooks are registered.
 */
export function wrapToolsWithHooks(
  tools: ToolSet,
  hooks: HookDispatcher,
): ToolSet {
  const wantsStart = hooks.hasHooksFor("tool.call.started");
  const wantsResult = hooks.hasHooksFor("tool.result");
  if (!wantsStart && !wantsResult) {
    return tools;
  }
  const wrapped: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    const originalExecute = tool.execute;
    if (typeof originalExecute !== "function") {
      wrapped[name] = tool;
      continue;
    }
    const call = originalExecute as (
      input: unknown,
      options: unknown,
    ) => unknown;
    const applyStart = async (input: unknown): Promise<unknown> => {
      if (!wantsStart) return input;
      const mutation = await hooks.runMutation("tool.call.started", {
        toolName: name,
        input: toLifecycleValue(input),
      });
      if (!mutation) return input;
      if (mutation.decision === "deny") {
        const reason =
          typeof mutation.denyReason === "string"
            ? mutation.denyReason
            : "denied by hook";
        throw new Error(`Tool "${name}" blocked by hook: ${reason}`);
      }
      return isPlainObject(mutation.args) ? mutation.args : input;
    };
    const applyResult = async (output: unknown): Promise<unknown> => {
      if (!wantsResult) return output;
      const mutation = await hooks.runMutation("tool.result", {
        toolName: name,
        output: toLifecycleValue(output as JSONValue),
      });
      return mutation && "output" in mutation ? mutation.output : output;
    };
    // A streaming tool stays a generator: an async wrapper would hand the SDK a
    // Promise and swallow every yield. Its yields pass through untouched and
    // tool.result rewrites only the last one, which is the tool's actual result.
    wrapped[name] = {
      ...tool,
      execute: isStreamingExecute(originalExecute)
        ? async function* (input: unknown, execOptions: unknown) {
            const result = call(await applyStart(input), execOptions);
            let last: unknown;
            if (isAsyncIterable(result)) {
              for await (const output of result) {
                last = output;
                yield output;
              }
            } else {
              last = await result;
            }
            const mutated = await applyResult(last);
            if (mutated !== last || !isAsyncIterable(result)) yield mutated;
          }
        : async (input: unknown, execOptions: unknown) =>
            await applyResult(await call(await applyStart(input), execOptions)),
    } as ToolSet[string];
  }
  return wrapped;
}

/**
 * Runs channel.message.sending hooks on an outbound reply. Returns null when a
 * hook drops the message, otherwise the (possibly rewritten) text. Shared by
 * every reply-delivery path so outbound policy cannot silently miss one.
 */
export async function applyMessageSendingHook(
  hooks: HookDispatcher,
  channel: string,
  text: string,
): Promise<string | null> {
  const mutation = await hooks.runMutation("channel.message.sending", {
    channel,
    text,
  });
  if (mutation?.drop === true) {
    return null;
  }

  return typeof mutation?.text === "string" ? mutation.text : text;
}

/** Resolve the active hook records referenced by the run's config.hooks.code. */
async function loadAgentHooks(
  accountId: string,
  refs: AgentCodeHookConfig[],
): Promise<AccountHookRecord[]> {
  const ids = [...new Set(refs.map((ref) => ref.hookId))];
  const store = getStorage().accountHooks;
  const records = await Promise.all(
    ids.map((id) => store.getById(accountId, id)),
  );
  return records.filter(
    (record): record is AccountHookRecord =>
      record != null && record.status === "active",
  );
}
