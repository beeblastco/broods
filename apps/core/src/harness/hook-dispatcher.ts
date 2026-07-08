/**
 * Per-run code hook dispatch.
 * Resolves an agent's configured code hooks (config.hooks.code) into an
 * event→records index, then runs the matching hooks at each fire-point and
 * merges their sanitized mutations. Per-event isolate execution + the
 * field-scoped mutation boundary live in hook-runner.ts; the fold into harness
 * state lives at the call sites (harness.ts / integrations.ts / subagents.ts).
 */

import type { JSONValue, ToolSet } from "ai";
import { isPlainObject } from "../shared/object.ts";
import type { AgentCodeHookConfig, AgentConfig, AgentHookEventName } from "../shared/storage/agent-config.ts";
import type { AccountHookRecord } from "../shared/storage/account-hooks.ts";
import type { AgentLifecycleEventPayload } from "./lifecycle.ts";
import { toLifecycleValue } from "./lifecycle.ts";
import { runCodeHook } from "./hook-runner.ts";

export interface HookDispatcher {
  hasHooksFor(event: AgentHookEventName): boolean;
  /** Runs every hook registered for the event and returns the merged, field-scoped mutation. */
  runMutation(event: AgentHookEventName, payload: AgentLifecycleEventPayload): Promise<Record<string, unknown> | undefined>;
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
  const refs = (agentConfig.hooks?.code ?? []).filter((ref) => ref.enabled !== false);
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
  return {
    hasHooksFor: (event) => index.has(event),
    async runMutation(event, payload) {
      const records = index.get(event);
      if (!records || records.length === 0) {
        return undefined;
      }
      // Hooks run in config order; later hooks' fields override earlier ones.
      let merged: Record<string, unknown> | undefined;
      for (const record of records) {
        const mutation = await runCodeHook({ accountId, record, event, payload });
        if (mutation) {
          merged = { ...(merged ?? {}), ...mutation };
        }
      }
      return merged;
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
    const events = ref.events ? record.events.filter((event) => ref.events!.includes(event)) : record.events;
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
export function wrapToolsWithHooks(tools: ToolSet, hooks: HookDispatcher): ToolSet {
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
    const execute = async (input: unknown, execOptions: unknown): Promise<unknown> => {
      let effectiveInput = input;
      if (wantsStart) {
        const mutation = await hooks.runMutation("tool.call.started", {
          toolName: name,
          toolCall: toLifecycleValue({ toolName: name, input }),
        });
        if (mutation) {
          if (mutation.decision === "deny") {
            const reason = typeof mutation.denyReason === "string" ? mutation.denyReason : "denied by hook";
            throw new Error(`Tool "${name}" blocked by hook: ${reason}`);
          }
          if (isPlainObject(mutation.args)) {
            effectiveInput = mutation.args;
          }
        }
      }
      let result = await (originalExecute as (input: unknown, options: unknown) => unknown)(effectiveInput, execOptions);
      if (wantsResult) {
        const mutation = await hooks.runMutation("tool.result", {
          toolName: name,
          toolResult: toLifecycleValue({ toolName: name, output: result as JSONValue }),
        });
        if (mutation && "output" in mutation) {
          result = mutation.output;
        }
      }
      return result;
    };
    wrapped[name] = { ...tool, execute } as ToolSet[string];
  }
  return wrapped;
}

/**
 * Resolve the referenced hook records from storage. STUB — returns [] until the
 * accountHooks storage adapter lands (built in parallel). Integration point:
 * replace the body with
 *   const store = getStorage().accountHooks;
 *   const records = await Promise.all(ids.map((id) => store.getById(accountId, id)));
 *   return records.filter((r): r is AccountHookRecord => r != null && r.status === "active");
 * once `getStorage().accountHooks` exists. Kept isolated so all fire-point
 * wiring compiles and is testable ahead of the storage adapter.
 */
async function loadAgentHooks(_accountId: string, _refs: AgentCodeHookConfig[]): Promise<AccountHookRecord[]> {
  return [];
}
