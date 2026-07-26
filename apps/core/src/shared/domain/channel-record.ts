/**
 * Channel records: an account-scoped row per real place a team talks — one Slack
 * channel, one Discord channel, one repository. It binds that place to an agent
 * and adds instructions, workspaces, policies and roles scoped to it.
 * Distinct from `config.channels`, which holds one adapter's credentials.
 * A record narrows and adds; it never grants capability the agent lacks.
 */

import type { SystemModelMessage } from "ai";
import { isPlainObject } from "../object.ts";
import type {
  AgentBehaviorConfig,
  AgentChannelWorkspaceScope,
  AgentConfig,
  AgentWorkspaceRef,
} from "./agent-config.ts";
import type { AgentPolicyMode } from "./agent-policy.ts";

export const CHANNEL_THREAD_POLICIES = ["always-thread", "inline"] as const;

const CHANNEL_CONFIG_KEYS = [
  "instructions",
  "agentBindings",
  "workspaces",
  "policyIds",
  "policyMode",
  "denyTools",
  "threadPolicy",
  "workspaceScope",
  "sandboxImages",
  "tagRoles",
] as const;
export type ChannelThreadPolicy = (typeof CHANNEL_THREAD_POLICIES)[number];

export interface ChannelAgentBinding {
  agentId: string;
  /** The agent a message runs on when nothing narrower matches. */
  isDefault?: boolean;
}

/** A named group of people, referenced from policy conditions by `actorRoles`. */
export interface ChannelTagRole {
  roleId: string;
  actorIds: string[];
}

export interface ChannelRecordConfig {
  /** Appended after the agent's own system prompt, never replacing it. */
  instructions?: string;
  agentBindings: ChannelAgentBinding[];
  workspaces?: AgentWorkspaceRef[];
  policyIds?: string[];
  /**
   * Enforcement stage for this channel. Set `audit` to watch a rule on a live
   * channel before it starts refusing anyone. Falls back to the agent's mode.
   */
  policyMode?: AgentPolicyMode;
  /** Tools to withhold here. Narrowing only — a channel cannot add a tool. */
  denyTools?: string[];
  threadPolicy?: ChannelThreadPolicy;
  workspaceScope?: AgentChannelWorkspaceScope;
  /** Images the agent may stand a sandbox up from for a thread in this channel. */
  sandboxImages?: string[];
  tagRoles?: ChannelTagRole[];
}

export interface ChannelRecord {
  accountId: string;
  channelRecordId: string;
  /** Adapter name the record belongs to, e.g. "slack". */
  platform: string;
  /** Provider id of the place: a Slack channel id, or an owner/repo. */
  externalId: string;
  /** Team or guild the place sits in, when the provider has one. */
  workspaceRef?: string;
  name: string;
  description?: string;
  config: ChannelRecordConfig;
  status: "active" | "deleted";
  createdAt: string;
  updatedAt: string;
}

export interface CreateChannelRecordInput {
  platform: string;
  externalId: string;
  workspaceRef?: string;
  name: string;
  description?: string;
  config: ChannelRecordConfig;
}

export interface UpdateChannelRecordInput {
  name?: string;
  description?: string | null;
  workspaceRef?: string | null;
  config?: ChannelRecordConfig;
  status?: ChannelRecord["status"];
}

/** The agent a message in this channel should run on. */
export function resolveChannelAgentId(
  record: ChannelRecord,
): string | undefined {
  const bindings = record.config.agentBindings;

  return (bindings.find((binding) => binding.isDefault) ?? bindings[0])
    ?.agentId;
}

// A provider id is only unique inside its team or guild, so a record naming one
// must match the message's. Either side unset means the provider gave us nothing
// to compare and the record stands.
export function channelRecordMatchesWorkspace(
  recordWorkspaceRef: string | undefined,
  messageWorkspaceRef: string | undefined,
): boolean {
  if (!recordWorkspaceRef || !messageWorkspaceRef) return true;

  return recordWorkspaceRef === messageWorkspaceRef;
}

/** Role ids an actor holds in this channel, for policy conditions. */
export function channelActorRoles(
  record: ChannelRecord,
  actorId: string | undefined,
): string[] {
  if (!actorId) return [];

  return (record.config.tagRoles ?? [])
    .filter((role) => role.actorIds.includes(actorId))
    .map((role) => role.roleId);
}

/**
 * Layer a channel record over the agent's runtime config for one turn.
 * Instructions append, workspaces and policies union, `denyTools` withholds —
 * a channel can take capability away but never hand any out, so reading the
 * agent still tells you its ceiling.
 */
export function applyChannelRecord(
  config: AgentConfig,
  record: ChannelRecord,
  channelName: string,
): AgentConfig {
  const channelConfig = record.config;
  const channelSettings = config.channels?.[channelName];
  const workspaces = mergeWorkspaceRefs(
    config.workspaces,
    channelConfig.workspaces,
  );
  const policyIds = [
    ...new Set([
      ...(config.policy?.policyIds ?? []),
      ...(channelConfig.policyIds ?? []),
    ]),
  ];
  const policyMode = channelConfig.policyMode ?? config.policy?.mode;
  const denyTools = channelConfig.denyTools?.length
    ? [...new Set([...(config.denyTools ?? []), ...channelConfig.denyTools])]
    : undefined;

  return {
    ...config,
    ...(channelConfig.instructions
      ? {
          agent: {
            ...config.agent,
            system: appendSystemInstructions(
              config.agent?.system,
              channelConfig.instructions,
            ),
          },
        }
      : {}),
    ...(workspaces ? { workspaces } : {}),
    ...(policyIds.length > 0
      ? {
          policy: {
            ...config.policy,
            policyIds,
            ...(policyMode ? { mode: policyMode } : {}),
          },
        }
      : {}),
    ...(denyTools ? { denyTools } : {}),
    // The scope entry is written even when the bound agent carries no config for
    // this channel — with an account-scoped webhook the credentials live on the
    // receiving agent, and an isolated workspace throws without a scope.
    ...(channelConfig.workspaceScope
      ? {
          channels: {
            ...config.channels,
            [channelName]: {
              ...(isPlainObject(channelSettings) ? channelSettings : {}),
              workspaceScope: channelConfig.workspaceScope,
            },
          },
        }
      : {}),
  };
}

export function normalizeChannelRecordConfig(
  value: unknown,
): ChannelRecordConfig {
  if (!isPlainObject(value)) {
    throw new Error("channel config must be an object");
  }
  const config = value as Record<string, unknown>;
  for (const key of Object.keys(config)) {
    if (
      !CHANNEL_CONFIG_KEYS.includes(key as (typeof CHANNEL_CONFIG_KEYS)[number])
    ) {
      throw new Error(`channel config.${key} is not supported`);
    }
  }

  const instructions = optionalString(
    config.instructions,
    "config.instructions",
  );
  const agentBindings = normalizeAgentBindings(config.agentBindings);
  const workspaces = normalizeChannelWorkspaces(config.workspaces);
  const policyIds = optionalStringArray(config.policyIds, "config.policyIds");
  const policyMode = normalizePolicyMode(config.policyMode);
  const denyTools = optionalStringArray(config.denyTools, "config.denyTools");
  const sandboxImages = optionalStringArray(
    config.sandboxImages,
    "config.sandboxImages",
  );
  const threadPolicy = normalizeThreadPolicy(config.threadPolicy);
  const workspaceScope = normalizeChannelWorkspaceScope(config.workspaceScope);
  const tagRoles = normalizeTagRoles(config.tagRoles);

  return {
    ...(instructions ? { instructions } : {}),
    agentBindings,
    ...(workspaces ? { workspaces } : {}),
    ...(policyIds ? { policyIds } : {}),
    ...(policyMode ? { policyMode } : {}),
    ...(denyTools ? { denyTools } : {}),
    ...(threadPolicy ? { threadPolicy } : {}),
    ...(workspaceScope ? { workspaceScope } : {}),
    ...(sandboxImages ? { sandboxImages } : {}),
    ...(tagRoles ? { tagRoles } : {}),
  };
}

export function normalizeCreateChannelRecordInput(
  value: unknown,
): CreateChannelRecordInput {
  if (!isPlainObject(value)) throw new Error("Request body must be an object");
  const input = value as Record<string, unknown>;
  const workspaceRef = optionalString(input.workspaceRef, "workspaceRef");
  const description = optionalString(input.description, "description");

  return {
    platform: requireString(input.platform, "platform"),
    externalId: requireString(input.externalId, "externalId"),
    name: requireString(input.name, "name"),
    ...(workspaceRef ? { workspaceRef } : {}),
    ...(description ? { description } : {}),
    config: normalizeChannelRecordConfig(input.config),
  };
}

export function normalizeUpdateChannelRecordInput(
  value: unknown,
): UpdateChannelRecordInput {
  if (!isPlainObject(value)) throw new Error("Request body must be an object");
  const input = value as Record<string, unknown>;
  const patch: UpdateChannelRecordInput = {};
  if (input.name !== undefined) patch.name = requireString(input.name, "name");
  if (input.description !== undefined) {
    patch.description =
      input.description === null
        ? null
        : (optionalString(input.description, "description") ?? null);
  }
  if (input.workspaceRef !== undefined) {
    patch.workspaceRef =
      input.workspaceRef === null
        ? null
        : (optionalString(input.workspaceRef, "workspaceRef") ?? null);
  }
  if (input.config !== undefined) {
    patch.config = normalizeChannelRecordConfig(input.config);
  }
  if (input.status !== undefined) {
    if (input.status !== "active" && input.status !== "deleted") {
      throw new Error("status must be one of: active, deleted");
    }
    patch.status = input.status;
  }

  return patch;
}

function appendSystemInstructions(
  system: AgentBehaviorConfig["system"],
  instructions: string,
): AgentBehaviorConfig["system"] {
  const appended: SystemModelMessage = {
    role: "system",
    content: instructions,
  };
  if (system === undefined) return [appended];
  if (typeof system === "string") {
    return [{ role: "system", content: system }, appended];
  }

  return Array.isArray(system) ? [...system, appended] : [system, appended];
}

/** Channel workspaces are added under their own names; the agent's ref wins on a clash. */
function mergeWorkspaceRefs(
  agentRefs: AgentWorkspaceRef[] | undefined,
  channelRefs: AgentWorkspaceRef[] | undefined,
): AgentWorkspaceRef[] | undefined {
  if (!channelRefs?.length) return undefined;
  const taken = new Set((agentRefs ?? []).map((ref) => ref.name));

  return [
    ...(agentRefs ?? []),
    ...channelRefs.filter((ref) => !taken.has(ref.name)),
  ];
}

function normalizeAgentBindings(value: unknown): ChannelAgentBinding[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("config.agentBindings must be a non-empty array");
  }
  const bindings = value.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new Error(`config.agentBindings[${index}] must be an object`);
    }
    const binding = entry as Record<string, unknown>;
    if (
      binding.isDefault !== undefined &&
      typeof binding.isDefault !== "boolean"
    ) {
      throw new Error(
        `config.agentBindings[${index}].isDefault must be a boolean`,
      );
    }

    return {
      agentId: requireString(
        binding.agentId,
        `config.agentBindings[${index}].agentId`,
      ),
      ...(binding.isDefault === true ? { isDefault: true } : {}),
    };
  });
  if (bindings.filter((binding) => binding.isDefault).length > 1) {
    throw new Error(
      "config.agentBindings may mark only one binding as default",
    );
  }

  return bindings;
}

function normalizeChannelWorkspaces(
  value: unknown,
): AgentWorkspaceRef[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error("config.workspaces must be an array");
  }

  return value.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new Error(`config.workspaces[${index}] must be an object`);
    }
    const ref = entry as Record<string, unknown>;

    return {
      name: requireString(ref.name, `config.workspaces[${index}].name`),
      workspaceId: requireString(
        ref.workspaceId,
        `config.workspaces[${index}].workspaceId`,
      ),
    };
  });
}

function normalizeChannelWorkspaceScope(
  value: unknown,
): AgentChannelWorkspaceScope | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new Error("config.workspaceScope must be an object");
  }
  const scope = value as Record<string, unknown>;
  if (scope.level === "channel") {
    if (scope.alias !== undefined) {
      throw new Error(
        "config.workspaceScope.alias is only supported when level is conversation",
      );
    }

    return { level: "channel" };
  }
  if (scope.level !== "conversation") {
    throw new Error(
      "config.workspaceScope.level must be one of: channel, conversation",
    );
  }

  return {
    level: "conversation",
    alias: requireString(scope.alias, "config.workspaceScope.alias"),
  };
}

function normalizePolicyMode(value: unknown): AgentPolicyMode | undefined {
  if (value === undefined) return undefined;
  if (value !== "enforce" && value !== "audit") {
    throw new Error("config.policyMode must be one of: enforce, audit");
  }

  return value;
}

function normalizeTagRoles(value: unknown): ChannelTagRole[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value))
    throw new Error("config.tagRoles must be an array");

  return value.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new Error(`config.tagRoles[${index}] must be an object`);
    }
    const role = entry as Record<string, unknown>;

    return {
      roleId: requireString(role.roleId, `config.tagRoles[${index}].roleId`),
      actorIds:
        optionalStringArray(
          role.actorIds,
          `config.tagRoles[${index}].actorIds`,
        ) ?? [],
    };
  });
}

function normalizeThreadPolicy(
  value: unknown,
): ChannelThreadPolicy | undefined {
  if (value === undefined) return undefined;
  if (!CHANNEL_THREAD_POLICIES.includes(value as ChannelThreadPolicy)) {
    throw new Error(
      `config.threadPolicy must be one of: ${CHANNEL_THREAD_POLICIES.join(", ")}`,
    );
  }

  return value as ChannelThreadPolicy;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalStringArray(
  value: unknown,
  name: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some(
      (entry) => typeof entry !== "string" || entry.trim().length === 0,
    )
  ) {
    throw new Error(`${name} must be an array of non-empty strings`);
  }

  return value as string[];
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }

  return value.trim();
}
