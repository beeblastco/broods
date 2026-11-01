// One row per real place a team talks (a Slack channel, a repo), not `config.channels` credentials.
// A record narrows and adds; it never grants capability the agent lacks.

import type { ChannelReplyIn } from "@broods/convex/model/channelRules";
import type { SystemModelMessage } from "ai";
import { logWarn } from "../log.ts";
import { isPlainObject } from "@broods/convex/model/objects";
import {
  toChannelRuntimeAgentConfig,
  type AgentBehaviorConfig,
  type ChannelPartition,
  type AgentConfig,
  type AgentWorkspaceRef,
} from "./agent-config.ts";
import type { AgentRecord } from "./agents.ts";

export type { ChannelReplyIn } from "@broods/convex/model/channelRules";
export { normalizeChannelRecordConfig } from "@broods/convex/model/channelRules";

export interface ChannelAgentBinding {
  agentId: string;
  isDefault?: boolean;
}

export interface ChannelTagRole {
  roleId: string;
  userIds: string[];
}

export interface ChannelRecordConfig {
  instructions?: string;
  agentBindings: ChannelAgentBinding[];
  workspaces?: AgentWorkspaceRef[];
  policies?: string[];
  denyTools?: string[];
  /** Slack only: no other provider gives the runtime a second place to reply. */
  replyIn?: ChannelReplyIn;
  partition?: ChannelPartition;
  sandboxImages?: string[];
  tagRoles?: ChannelTagRole[];
}

export interface ChannelRecord {
  accountId: string;
  channelRecordId: string;
  platform: string;
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

export function applyChannelRecord(
  config: AgentConfig,
  record: ChannelRecord,
  channelName: string,
): AgentConfig {
  const channelConfig = record.config;
  const channelSettings = config.channels?.[channelName];
  const workspaces = selectWorkspaceRefs(
    config.workspaces,
    channelConfig.workspaces,
  );
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
    // Set even when the agent has no config for this channel: an isolated workspace needs a scope.
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

export function channelActorRoles(
  record: ChannelRecord,
  userId: string | undefined,
): string[] {
  if (!userId) return [];

  return (record.config.tagRoles ?? [])
    .filter((role) => role.userIds.includes(userId))
    .map((role) => role.roleId);
}

// Provider ids are unique only per team or guild; an unset side leaves nothing to compare.
export function channelRecordMatchesWorkspace(
  recordWorkspaceRef: string | undefined,
  messageWorkspaceRef: string | undefined,
): boolean {
  if (!recordWorkspaceRef || !messageWorkspaceRef) return true;

  return recordWorkspaceRef === messageWorkspaceRef;
}

// The credential holder's channel entry wins: the reply must come from that app.
export function channelRuntimeAgentConfig(
  target: { agent: AgentRecord; record?: ChannelRecord },
  channelName: string,
  credentialHolderConfig: AgentConfig,
): AgentConfig {
  const targetConfig = toChannelRuntimeAgentConfig(
    target.agent.config,
    channelName,
  );
  const credentialChannel = credentialHolderConfig.channels?.[channelName];
  const config = credentialChannel
    ? {
        ...targetConfig,
        channels: {
          ...targetConfig.channels,
          [channelName]: credentialChannel,
        },
      }
    : targetConfig;

  return target.record
    ? applyChannelRecord(config, target.record, channelName)
    : config;
}

export function resolveChannelAgentId(
  record: ChannelRecord,
): string | undefined {
  const bindings = record.config.agentBindings;

  return (bindings.find((binding) => binding.isDefault) ?? bindings[0])
    ?.agentId;
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

// Attaching a workspace grants sandbox file tools, so a record only picks among the agent's refs:
// a ref under a new name would inherit the default sandbox and turn a read-only mount writable.
function selectWorkspaceRefs(
  agentRefs: AgentWorkspaceRef[] | undefined,
  channelRefs: AgentWorkspaceRef[] | undefined,
): AgentWorkspaceRef[] | undefined {
  if (!channelRefs?.length) return undefined;
  const attached = new Set((agentRefs ?? []).map((ref) => ref.workspaceId));
  const named = new Set(channelRefs.map((ref) => ref.workspaceId));
  for (const ref of channelRefs) {
    if (!attached.has(ref.workspaceId)) {
      logWarn("Channel record workspace ignored: agent does not attach it", {
        name: ref.name,
        workspaceId: ref.workspaceId,
      });
    }
  }

  return (agentRefs ?? []).filter((ref): boolean => named.has(ref.workspaceId));
}
