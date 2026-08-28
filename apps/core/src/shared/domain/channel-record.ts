/**
 * Channel records: an account-scoped row per real place a team talks — one Slack
 * channel, one Discord channel, one repository. It binds that place to an agent
 * and adds instructions, workspaces, policies and roles scoped to it.
 * Distinct from `config.channels`, which holds one adapter's credentials.
 * A record narrows and adds; it never grants capability the agent lacks.
 * Input validation lives in the config plane
 * (packages/convex/model/channelRules.ts) and is re-exported here.
 */

import type { ChannelReplyIn } from "@broods/convex/model/channelRules";
import type { SystemModelMessage } from "ai";
import { logWarn } from "../log.ts";
import { isPlainObject } from "../object.ts";
import type {
  AgentBehaviorConfig,
  ChannelPartition,
  AgentConfig,
  AgentWorkspaceRef,
} from "./agent-config.ts";

export type { ChannelReplyIn } from "@broods/convex/model/channelRules";
export {
  CHANNEL_REPLY_TARGETS,
  normalizeChannelRecordConfig,
  normalizeCreateChannelRecordInput,
  normalizeUpdateChannelRecordInput,
} from "@broods/convex/model/channelRules";

export interface ChannelAgentBinding {
  agentId: string;
  /** The agent a message runs on when nothing narrower matches. */
  isDefault?: boolean;
}

/** A named group of people, referenced from policy conditions by `userRoles`. */
export interface ChannelTagRole {
  roleId: string;
  userIds: string[];
}

export interface ChannelRecordConfig {
  /** Appended after the agent's own system prompt, never replacing it. */
  instructions?: string;
  agentBindings: ChannelAgentBinding[];
  /** Narrowing only: entries the agent does not already attach are ignored. */
  workspaces?: AgentWorkspaceRef[];
  /** Added to whatever the agent already carries. Each policy holds its own mode. */
  policies?: string[];
  /** Tools to withhold here. Narrowing only — a channel cannot add a tool. */
  denyTools?: string[];
  /**
   * Where the reply lands. `source` answers wherever the message came from, and
   * threads only when the message already did. Slack only: no other provider
   * gives the runtime a second place to reply.
   */
  replyIn?: ChannelReplyIn;
  partition?: ChannelPartition;
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
  userId: string | undefined,
): string[] {
  if (!userId) return [];

  return (record.config.tagRoles ?? [])
    .filter((role) => role.userIds.includes(userId))
    .map((role) => role.roleId);
}

/**
 * Layer a channel record over the agent's runtime config for one turn.
 * Instructions append and policies union; workspaces and tools only narrow.
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
  // A record adds policies, it never drops the agent's own.
  const policies = [
    ...new Set([...(config.policies ?? []), ...(channelConfig.policies ?? [])]),
  ];
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
    ...(workspaces ? { workspaces: workspaces } : {}),
    ...(policies.length > 0 ? { policies: policies } : {}),
    ...(denyTools ? { denyTools: denyTools } : {}),
    // The scope entry is written even when the bound agent carries no config for
    // this channel — with an account-scoped webhook the credentials live on the
    // receiving agent, and an isolated workspace throws without a scope.
    ...(channelConfig.partition
      ? {
          channels: {
            ...config.channels,
            [channelName]: {
              ...(isPlainObject(channelSettings) ? channelSettings : {}),
              partition: channelConfig.partition,
            },
          },
        }
      : {}),
  };
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

// A workspace is capability, not configuration: attaching one is what materialises
// the sandbox file tools. So a record may only name a workspace the agent already
// attaches — anything else would hand out filesystem access the agent lacks.
function mergeWorkspaceRefs(
  agentRefs: AgentWorkspaceRef[] | undefined,
  channelRefs: AgentWorkspaceRef[] | undefined,
): AgentWorkspaceRef[] | undefined {
  if (!channelRefs?.length) return undefined;
  const taken = new Set((agentRefs ?? []).map((ref) => ref.name));
  const attached = new Set((agentRefs ?? []).map((ref) => ref.workspaceId));
  const allowed = channelRefs.filter(
    (ref) => !taken.has(ref.name) && attached.has(ref.workspaceId),
  );
  for (const ref of channelRefs) {
    if (!attached.has(ref.workspaceId)) {
      logWarn("Channel record workspace ignored: agent does not attach it", {
        name: ref.name,
        workspaceId: ref.workspaceId,
      });
    }
  }

  const merged = [...(agentRefs ?? []), ...allowed];

  return merged.length > 0 ? merged : undefined;
}
