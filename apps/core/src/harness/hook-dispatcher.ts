import { asSchema, type JSONValue, type Tool, type ToolSet } from "ai";
import type { AccountHookRecord } from "../shared/domain/account-hooks.ts";
import type {
  AgentCodeHookConfig,
  AgentConfig,
  AgentHookEventName,
  HookAgentConfig,
} from "../shared/domain/agent-config.ts";
import { isPlainObject } from "@broods/convex/model/objects";
import { getStorage } from "../shared/storage.ts";
import { runCodeHook } from "./hook-runner.ts";
import type { AgentLifecycleEventPayload } from "./lifecycle.ts";
import { toLifecycleValue } from "./lifecycle.ts";
import { wrapToolExecute } from "./tool-execute.ts";

export interface HookDispatcher {
  hasHooksFor(event: AgentHookEventName): boolean;
  runMutation(
    event: AgentHookEventName,
    payload: AgentLifecycleEventPayload,
  ): Promise<Record<string, unknown> | undefined>;
}

const NO_HOOKS: HookDispatcher = {
  hasHooksFor: (): boolean => false,
  runMutation: async function (): Promise<Record<string, unknown> | undefined> {
    return undefined;
  },
};

export async function applyMessageSendingHook(
  hooks: HookDispatcher,
  channel: string,
  text: string,
): Promise<string | null> {
  const mutation = await hooks.runMutation("channel.message.sending", {
    channel: channel,
    text: text,
  });
  if (mutation?.drop === true) {
    return null;
  }

  return typeof mutation?.text === "string" ? mutation.text : text;
}

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

  return createHookDispatcher(accountId, index, hookVisibleConfig(agentConfig));
}

export function createHookDispatcher(
  accountId: string,
  index: Map<AgentHookEventName, AccountHookRecord[]>,
  config: HookAgentConfig,
): HookDispatcher {
  let runState: Record<string, unknown> = {};
  // Fire-points overlap (parallel tool calls), so runs queue: no two update runState at once.
  let queue: Promise<unknown> = Promise.resolve();

  return {
    hasHooksFor: (event): boolean => index.has(event),
    runMutation: async function (
      event,
      payload,
    ): Promise<Record<string, unknown> | undefined> {
      const records = index.get(event);
      if (!records || records.length === 0) {
        return undefined;
      }
      const run = queue.then(async () => {
        const mutations: Record<string, unknown>[] = [];
        for (const record of records) {
          const { mutation, state } = await runCodeHook({
            accountId: accountId,
            record: record,
            event: event,
            payload: payload,
            config: config,
            state: runState,
          });
          runState = state;
          if (mutation) mutations.push(mutation);
        }

        return mutations.length > 0
          ? Object.fromEntries(mutations.flatMap((m) => Object.entries(m)))
          : undefined;
      });
      queue = run.catch(() => undefined);

      return run;
    },
  };
}

export function wrapToolsWithHooks(
  tools: ToolSet,
  hooks: HookDispatcher,
): ToolSet {
  const wantsStart = hooks.hasHooksFor("tool.call.started");
  const wantsResult = hooks.hasHooksFor("tool.result");
  if (!wantsStart && !wantsResult) {
    return tools;
  }

  return wrapToolExecute(tools, (name) => ({
    before: async (input: unknown) => {
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

      return isPlainObject(mutation.args)
        ? hookArgs(tools[name]!, name, mutation.args)
        : input;
    },
    after: async (output: unknown) => {
      if (!wantsResult) return output;
      const mutation = await hooks.runMutation("tool.result", {
        toolName: name,
        output: toLifecycleValue(output as JSONValue),
      });

      return mutation && "output" in mutation ? mutation.output : output;
    },
  }));
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

// The schema check the SDK ran on the model's args; no runtime schema = accepted, as in the SDK.
async function hookArgs(
  tool: Tool,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const { validate } = asSchema(tool.inputSchema);
  if (!validate) {
    return args;
  }
  const result = await validate(args);
  if (!result.success) {
    throw new Error(
      `Tool "${name}" got invalid args from hook: ${result.error.message}`,
    );
  }

  return result.value;
}

function hookVisibleConfig(agentConfig: AgentConfig): HookAgentConfig {
  return {
    model: {
      provider: agentConfig.model?.provider,
      modelId: agentConfig.model?.modelId,
    },
    harness: agentConfig.harness?.type,
    maxTurn: agentConfig.agent?.maxTurn,
    tools: Object.keys(agentConfig.tools ?? {}),
    mcp: Object.keys(agentConfig.mcp ?? {}),
    channels: Object.keys(agentConfig.channels ?? {}),
    skills: agentConfig.skills?.allowed ?? [],
    subagents: agentConfig.subagent?.allowed ?? [],
    denyTools: agentConfig.denyTools ?? [],
  };
}

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
