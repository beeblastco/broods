/**
 * CLI manifest sync for channel records: name→id resolution against the synced
 * agents/workspaces/policies, the one-record-per-place ownership guard, prune,
 * and the inverse id→name mapping used when reading the manifest back.
 */

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { normalizeChannelRecordConfig } from "./channelRules";
import { resourceName, type CliResource } from "./cliSync";
import { isPlainObject } from "./objects";

/**
 * Inverse of `resolveChannelRecordRefs`: ids back to resource names, and the
 * place columns folded back into the config the manifest declares. It must land
 * exactly where the local manifest normalizes, or `broods dev` reports a diff
 * that never settles.
 */
export function channelRecordManifestConfig(
  record: Doc<"channelRecords">,
  names: {
    agentNames: Record<string, string>;
    policyNames: Record<string, string>;
    workspaceNames: Record<string, string>;
  },
): Record<string, unknown> {
  const config = isPlainObject(record.config)
    ? (record.config as Record<string, unknown>)
    : {};
  const { agentBindings, policyIds, workspaces, ...rest } = config;

  return {
    platform: record.platform,
    externalId: record.externalId,
    ...(record.workspaceRef ? { workspaceRef: record.workspaceRef } : {}),
    agents: (Array.isArray(agentBindings) ? agentBindings : []).map((entry) =>
      isPlainObject(entry) && typeof entry.agentId === "string"
        ? (names.agentNames[entry.agentId] ?? entry.agentId)
        : entry,
    ),
    ...rest,
    ...(Array.isArray(policyIds)
      ? {
          policies: policyIds.map((entry) =>
            typeof entry === "string"
              ? (names.policyNames[entry] ?? entry)
              : entry,
          ),
        }
      : {}),
    ...(Array.isArray(workspaces)
      ? {
          workspaces: workspaces.map((entry) =>
            isPlainObject(entry) && typeof entry.workspaceId === "string"
              ? {
                  ...entry,
                  workspaceId:
                    names.workspaceNames[entry.workspaceId] ??
                    entry.workspaceId,
                }
              : entry,
          ),
        }
      : {}),
  };
}

export async function pruneChannelRecordResources(
  ctx: MutationCtx,
  stageId: Id<"stages">,
  resources: CliResource[],
): Promise<void> {
  const declared = new Set(
    resources
      .filter((entry) => entry.kind === "channelRecord")
      .map((entry) => resourceName(entry.name)),
  );
  const existing = await ctx.db
    .query("channelRecords")
    .withIndex("by_stageId_and_name", (q) => q.eq("stageId", stageId))
    .collect();
  for (const record of existing) {
    if (record.managedBy === "cli" && !declared.has(record.name)) {
      await ctx.db.patch(record._id, {
        status: "deleted",
        deletedAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
  }
}

/**
 * Channel records name agents, workspaces and policies by resource name, so this
 * runs after those are synced and their ids are known. A record is unique per
 * `(account, platform, externalId)` because the inbound webhook looks it up that
 * way — so two stages cannot both claim one Slack channel, and trying is
 * an error rather than a silent last-writer-wins.
 */
export async function syncChannelRecordResources(
  ctx: MutationCtx,
  options: {
    accountId: Id<"accounts">;
    projectId: Id<"projects">;
    stageId: Id<"stages">;
    resources: CliResource[];
    agentIds: Record<string, string>;
    workspaceIds: Record<string, string>;
    policyIds: Record<string, string>;
  },
): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  const records = options.resources.filter(
    (entry) => entry.kind === "channelRecord",
  );
  if (records.length === 0) return ids;

  const existing = await ctx.db
    .query("channelRecords")
    .withIndex("by_stageId_and_name", (q) => q.eq("stageId", options.stageId))
    .collect();

  for (const resource of records) {
    const name = resourceName(resource.name);
    const input = resolveChannelRecordRefs(resource.config, options);
    const platform = requireChannelRecordString(input.platform, "platform");
    const externalId = requireChannelRecordString(
      input.externalId,
      "externalId",
    );
    // Same validation the CRUD route runs: a malformed manifest record must fail
    // the deploy, not reach the webhook resolver at runtime.
    const config = normalizeChannelRecordConfig(input.config);
    await assertChannelRecordPlaceIsFree(ctx, {
      accountId: options.accountId,
      stageId: options.stageId,
      platform: platform,
      externalId: externalId,
      name: name,
    });

    const current = existing.find((entry) => entry.name === name);
    const patch = {
      accountId: options.accountId,
      projectId: options.projectId,
      stageId: options.stageId,
      platform: platform,
      externalId: externalId,
      ...(typeof input.workspaceRef === "string"
        ? { workspaceRef: input.workspaceRef }
        : { workspaceRef: undefined }),
      name: name,
      description: resource.description,
      config: config,
      status: "active" as const,
      managedBy: "cli" as const,
      updatedAt: Date.now(),
      deletedAt: undefined,
    };
    if (current) {
      await ctx.db.patch(current._id, patch);
      ids[name] = current._id;
      continue;
    }
    const now = Date.now();
    ids[name] = await ctx.db.insert("channelRecords", {
      ...patch,
      createdAt: now,
    });
  }

  return ids;
}

/**
 * The webhook resolves a place account-wide, so one `(platform, externalId)` can
 * belong to exactly one record. Reject a second claim instead of overwriting.
 */
async function assertChannelRecordPlaceIsFree(
  ctx: MutationCtx,
  options: {
    accountId: Id<"accounts">;
    stageId: Id<"stages">;
    platform: string;
    externalId: string;
    name: string;
  },
): Promise<void> {
  const rows = await ctx.db
    .query("channelRecords")
    .withIndex("by_accountId_platform_external", (q) =>
      q
        .eq("accountId", options.accountId)
        .eq("platform", options.platform)
        .eq("externalId", options.externalId),
    )
    .collect();
  const conflict = rows.find(
    (row) =>
      row.status === "active" &&
      !(row.stageId === options.stageId && row.name === options.name),
  );
  if (!conflict) return;

  throw new Error(
    `channelRecord "${options.name}" claims ${options.platform}:${options.externalId}, ` +
      `which record "${conflict.name}" already owns. One place binds to one record.`,
  );
}

function requireChannelRecordString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`channelRecord ${field} must be a non-empty string`);
  }

  return value;
}

/** A record's agents, workspaces and policies are written as resource names. */
function resolveChannelRecordRefs(
  raw: unknown,
  ids: {
    agentIds: Record<string, string>;
    workspaceIds: Record<string, string>;
    policyIds: Record<string, string>;
  },
): {
  platform: unknown;
  externalId: unknown;
  workspaceRef: unknown;
  config: unknown;
} {
  if (!isPlainObject(raw)) {
    throw new Error("channelRecord config must be an object");
  }
  const {
    platform,
    externalId,
    workspaceRef,
    agents,
    policies,
    workspaces,
    ...rest
  } = raw as Record<string, unknown>;
  const agentBindings = (Array.isArray(agents) ? agents : []).map(
    (entry, index) => {
      const agentName = typeof entry === "string" ? entry : "";
      const agentId = ids.agentIds[agentName] ?? agentName;

      return { agentId: agentId, ...(index === 0 ? { isDefault: true } : {}) };
    },
  );

  return {
    platform: platform,
    externalId: externalId,
    workspaceRef: workspaceRef,
    config: {
      ...rest,
      agentBindings: agentBindings,
      ...(Array.isArray(policies)
        ? {
            policyIds: policies.map((entry) =>
              typeof entry === "string"
                ? (ids.policyIds[entry] ?? entry)
                : entry,
            ),
          }
        : {}),
      ...(Array.isArray(workspaces)
        ? {
            workspaces: workspaces.map((entry) =>
              isPlainObject(entry) && typeof entry.workspaceId === "string"
                ? {
                    ...entry,
                    workspaceId:
                      ids.workspaceIds[entry.workspaceId] ?? entry.workspaceId,
                  }
                : entry,
            ),
          }
        : {}),
    },
  };
}
