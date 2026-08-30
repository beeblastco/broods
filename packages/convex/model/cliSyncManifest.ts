/**
 * Manifest read-back for CLI sync: projects the stage's stored rows (agents,
 * policies, channel records, external resources, sandboxes, workspaces, crons)
 * back into manifest resources and name→id maps, with ids rewritten to the
 * resource names the local manifest declares.
 */

import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { GeneratedIds } from "../cli/types";
import { toNestedAgentConfig } from "./agentConfigCodec";
import {
  decryptSandboxManifestConfig,
  rewriteIdsToNames,
  type CliResource,
} from "./cliSync";
import { channelRecordManifestConfig } from "./cliSyncChannels";

export async function externalIdsForStage(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<"projects">,
  stageId: Id<"stages">,
): Promise<{
  skills: Record<string, string>;
  hooks: Record<string, string>;
  mcp: Record<string, string>;
}> {
  const resources = await ctx.db
    .query("cliExternalResources")
    .withIndex("by_projectId_and_stageId", (q) =>
      q.eq("projectId", projectId).eq("stageId", stageId),
    )
    .collect();

  return {
    skills: Object.fromEntries(
      resources
        .filter((entry) => entry.kind === "skill")
        .map((entry) => [entry.name, entry.externalId]),
    ),
    hooks: Object.fromEntries(
      resources
        .filter((entry) => entry.kind === "hook")
        .map((entry) => [entry.name, entry.externalId]),
    ),
    mcp: Object.fromEntries(
      resources
        .filter((entry) => entry.kind === "mcp")
        .map((entry) => [entry.name, entry.externalId]),
    ),
  };
}

export async function idsForStage(
  ctx: QueryCtx | MutationCtx,
  accountId: Id<"accounts">,
  projectId: Id<"projects">,
  stageId: Id<"stages">,
): Promise<GeneratedIds> {
  const sandboxes = await ctx.db
    .query("sandboxConfigs")
    .withIndex("by_stageId_and_name", (q) => q.eq("stageId", stageId))
    .collect();
  const workspaces = await ctx.db
    .query("workspaceConfigs")
    .withIndex("by_stageId_and_name", (q) => q.eq("stageId", stageId))
    .collect();
  const agents = await ctx.db
    .query("agentConfigs")
    .withIndex("by_projectId_and_stageId", (q) =>
      q.eq("projectId", projectId).eq("stageId", stageId),
    )
    .collect();
  const policies = await ctx.db
    .query("agentPolicies")
    .withIndex("by_stageId_and_name", (q) => q.eq("stageId", stageId))
    .collect();
  const channelRecords = await ctx.db
    .query("channelRecords")
    .withIndex("by_stageId_and_name", (q) => q.eq("stageId", stageId))
    .collect();
  const agentIds = new Set(
    agents.flatMap((entry) => (entry.agentId ? [entry.agentId] : [])),
  );
  const crons = (
    await Promise.all(
      [...agentIds].map((agentId) =>
        ctx.db
          .query("crons")
          .withIndex("by_accountId_and_agentId", (q) =>
            q.eq("accountId", accountId).eq("agentId", agentId as Id<"agents">),
          )
          .collect(),
      ),
    )
  ).flat();
  const externalIds = await externalIdsForStage(ctx, projectId, stageId);

  return {
    agents: Object.fromEntries(
      agents
        .filter((entry) => entry.managedBy === "cli")
        .flatMap((entry) =>
          entry.agentId ? [[entry.name, entry.agentId]] : [],
        ),
    ),
    workspaces: Object.fromEntries(
      workspaces
        .filter((entry) => entry.managedBy === "cli")
        .map((entry) => [entry.name, entry._id]),
    ),
    sandboxes: Object.fromEntries(
      sandboxes
        .filter((entry) => entry.managedBy === "cli")
        .map((entry) => [entry.name, entry._id]),
    ),
    crons: Object.fromEntries(
      crons.flatMap((entry) =>
        agentIds.has(entry.agentId) ? [[entry.name, entry._id]] : [],
      ),
    ),
    skills: externalIds.skills,
    hooks: externalIds.hooks,
    mcp: externalIds.mcp,
    policies: Object.fromEntries(
      policies
        .filter(
          (entry) => entry.managedBy === "cli" && entry.status === "active",
        )
        .map((entry) => [entry.name, entry._id]),
    ),
    channelRecords: Object.fromEntries(
      channelRecords
        .filter(
          (entry) => entry.managedBy === "cli" && entry.status === "active",
        )
        .map((entry) => [entry.name, entry._id]),
    ),
  };
}

export async function resourcesForStage(
  ctx: QueryCtx | MutationCtx,
  accountId: Id<"accounts">,
  projectId: Id<"projects">,
  stageId: Id<"stages">,
): Promise<CliResource[]> {
  const sandboxes = await ctx.db
    .query("sandboxConfigs")
    .withIndex("by_stageId_and_name", (q) => q.eq("stageId", stageId))
    .collect();
  const workspaces = await ctx.db
    .query("workspaceConfigs")
    .withIndex("by_stageId_and_name", (q) => q.eq("stageId", stageId))
    .collect();
  const agents = await ctx.db
    .query("agentConfigs")
    .withIndex("by_projectId_and_stageId", (q) =>
      q.eq("projectId", projectId).eq("stageId", stageId),
    )
    .collect();
  const policies = await ctx.db
    .query("agentPolicies")
    .withIndex("by_stageId_and_name", (q) => q.eq("stageId", stageId))
    .collect();
  const channelRecords = await ctx.db
    .query("channelRecords")
    .withIndex("by_stageId_and_name", (q) => q.eq("stageId", stageId))
    .collect();
  const agentIds = agents.flatMap((entry) =>
    entry.agentId ? [entry.agentId] : [],
  );
  const crons = (
    await Promise.all(
      agentIds.map((agentId) =>
        ctx.db
          .query("crons")
          .withIndex("by_accountId_and_agentId", (q) =>
            q.eq("accountId", accountId).eq("agentId", agentId as Id<"agents">),
          )
          .collect(),
      ),
    )
  ).flat();
  const sandboxNames = Object.fromEntries(
    sandboxes.map((entry) => [entry._id, entry.name]),
  );
  const workspaceNames = Object.fromEntries(
    workspaces.map((entry) => [entry._id, entry.name]),
  );
  const agentNames = Object.fromEntries(
    agents.flatMap((entry) =>
      entry.agentId ? [[entry.agentId, entry.name]] : [],
    ),
  );
  const externalResources = await ctx.db
    .query("cliExternalResources")
    .withIndex("by_projectId_and_stageId", (q) =>
      q.eq("projectId", projectId).eq("stageId", stageId),
    )
    .collect();
  const skillNames = Object.fromEntries(
    externalResources
      .filter((entry) => entry.kind === "skill")
      .map((entry) => [entry.externalId, entry.name]),
  );
  const hookNames = Object.fromEntries(
    externalResources
      .filter((entry) => entry.kind === "hook")
      .map((entry) => [entry.externalId, entry.name]),
  );
  const mcpNames = Object.fromEntries(
    externalResources
      .filter((entry) => entry.kind === "mcp")
      .map((entry) => [entry.externalId, entry.name]),
  );
  const policyNames = Object.fromEntries(
    policies
      .filter((entry) => entry.managedBy === "cli" && entry.status === "active")
      .map((entry) => [entry._id, entry.name]),
  );

  // sandboxConfigs is stored encrypted (broods contract); decrypt back
  // into the manifest shape the CLI expects.
  const secret = process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET;
  const sandboxResources: CliResource[] = await Promise.all(
    sandboxes
      .filter((sandbox) => sandbox.managedBy === "cli")
      .map(async (sandbox): Promise<CliResource> => ({
        kind: "sandbox",
        name: sandbox.name,
        description: sandbox.description,
        config: await decryptSandboxManifestConfig(sandbox, secret),
      })),
  );

  return [
    ...agents
      .filter((agent) => agent.managedBy === "cli")
      .map((agent): CliResource => ({
        kind: "agent",
        name: agent.name,
        description: agent.description,
        config: rewriteIdsToNames(
          toNestedAgentConfig({
            name: agent.name,
            description: agent.description,
            provider: agent.provider,
            modelId: agent.modelId,
            systemPrompt: agent.systemPrompt,
            maxTurns: agent.maxTurns,
            outputFormat: agent.outputFormat as
              | Record<string, unknown>
              | undefined,
            providerOptions: agent.providerOptions as
              | Record<string, unknown>
              | undefined,
            temperature: agent.temperature,
            maxTokens: agent.maxTokens,
            memoryToolEnabled: agent.memoryToolEnabled,
            searchToolEnabled: agent.searchToolEnabled,
            searchToolConfig: agent.searchToolConfig as
              | Record<string, unknown>
              | undefined,
            extraConfig: agent.extraConfig as
              | Record<string, unknown>
              | undefined,
          }),
          {
            workspaces: workspaceNames,
            sandboxes: sandboxNames,
            agents: agentNames,
            skills: skillNames,
            hooks: hookNames,
            mcp: mcpNames,
            policies: policyNames,
          },
        ),
      })),
    ...policies
      .filter(
        (policy) => policy.managedBy === "cli" && policy.status === "active",
      )
      .map((policy): CliResource => ({
        kind: "policy",
        name: policy.name,
        description: policy.description,
        config: policy.document,
      })),
    ...channelRecords
      .filter(
        (record) => record.managedBy === "cli" && record.status === "active",
      )
      .map((record): CliResource => ({
        kind: "channelRecord",
        name: record.name,
        description: record.description,
        config: channelRecordManifestConfig(record, {
          agentNames: agentNames,
          policyNames: policyNames,
          workspaceNames: workspaceNames,
        }),
      })),
    ...externalResources.map((resource): CliResource => ({
      kind: resource.kind,
      name: resource.name,
      description: resource.description,
      config: resource.config,
    })),
    ...sandboxResources,
    ...workspaces
      .filter((workspace) => workspace.managedBy === "cli")
      .map((workspace): CliResource => ({
        kind: "workspace",
        name: workspace.name,
        description: workspace.description,
        config: workspace.config,
      })),
    ...crons.flatMap((cron): CliResource[] => {
      const agentName = agentNames[cron.agentId];
      if (!agentName) return [];

      return [
        {
          kind: "cron",
          name: cron.name,
          description: cron.description,
          config: {
            name: cron.name,
            agentId: agentName,
            events: cron.events,
            scheduleExpression: cron.scheduleExpression,
            ...(cron.conversationKey
              ? { conversationKey: cron.conversationKey }
              : {}),
            ...(cron.timezone ? { timezone: cron.timezone } : {}),
            status: cron.status,
          },
        },
      ];
    }),
  ].sort((a, b) => `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`));
}
