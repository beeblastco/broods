/**
 * Workspace config CRUD scoped to an account. Mirrors sandboxConfigs.ts, but the
 * config object holds no secrets and is stored in plaintext. The doc _id is the
 * public workspaceId; every mutation revalidates ownership against the
 * caller-supplied accountId. Also mints an R2 workspace's scoped credentials,
 * since only Convex can decrypt the env vars its keys reference.
 */

import { v, type Infer } from "convex/values";
import { paginationOptsValidator, type PaginationResult } from "convex/server";
import { internalMutation, internalQuery } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { loadValuesForAccount } from "../account/envVars";
import { ACCOUNT_ENV_REF_PATTERN } from "../model/envRefs";
import { loadEnvironmentVariableValues } from "../model/environmentValues";
import {
  createR2Credentials,
  type R2Credentials,
} from "../model/r2Credentials";
import {
  normalizeWorkspaceConfig,
  normalizeWorkspacePrefix,
  workspaceEnvRefFields,
  workspaceStorageOwnAuth,
  type WorkspaceConfig,
} from "../model/workspaceRules";
import { workspaceConfigsFields, paginationCursorFields } from "../schema";
import { ClientError } from "../model/clientError";

const workspaceConfigDoc = v.object({
  ...workspaceConfigsFields,
  _id: v.id("workspaceConfigs"),
  _creationTime: v.number(),
});

const storageRuleViolation = v.object({
  workspaceId: v.id("workspaceConfigs"),
  accountId: v.id("accounts"),
  name: v.string(),
  bucket: v.optional(v.string()),
  reason: v.string(),
});

/**
 * Look up a workspace config by the public string id. The validator accepts
 * `v.string()` (not `v.id`) so unknown ids resolve to `null` instead of throwing.
 */
export const getById = internalQuery({
  args: {
    accountId: v.id("accounts"),
    workspaceId: v.string(),
  },
  returns: v.union(workspaceConfigDoc, v.null()),
  handler: async (ctx, args): Promise<Doc<"workspaceConfigs"> | null> => {
    const normalized = ctx.db.normalizeId("workspaceConfigs", args.workspaceId);
    if (!normalized) return null;
    const doc = await ctx.db.get(normalized);
    if (!doc || doc.accountId !== args.accountId) return null;

    return doc;
  },
});

export const list = internalQuery({
  args: { accountId: v.id("accounts") },
  returns: v.array(workspaceConfigDoc),
  handler: async (ctx, args): Promise<Doc<"workspaceConfigs">[]> => {
    return await ctx.db
      .query("workspaceConfigs")
      .withIndex("by_accountId_and_name", (q) =>
        q.eq("accountId", args.accountId),
      )
      .collect();
  },
});

export const listPage = internalQuery({
  args: {
    accountId: v.id("accounts"),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    page: v.array(workspaceConfigDoc),
    ...paginationCursorFields,
  }),
  handler: async (
    ctx,
    args,
  ): Promise<PaginationResult<Doc<"workspaceConfigs">>> => {
    return await ctx.db
      .query("workspaceConfigs")
      .withIndex("by_accountId_and_name", (q) =>
        q.eq("accountId", args.accountId),
      )
      .paginate(args.paginationOpts);
  },
});

/**
 * One page of stored workspaces that today's config rules refuse. Rows written
 * before a rule existed are never rewritten, they fail to resolve.
 */
export const listStorageRuleViolations = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: v.object({
    violations: v.array(storageRuleViolation),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    violations: Infer<typeof storageRuleViolation>[];
    isDone: boolean;
    continueCursor: string;
  }> => {
    const result = await ctx.db
      .query("workspaceConfigs")
      .paginate(args.paginationOpts);
    const violations = result.page.flatMap((doc) => {
      try {
        normalizeWorkspaceConfig(doc.config);

        return [];
      } catch (error) {
        const bucket = (doc.config as Partial<WorkspaceConfig> | null)?.storage
          ?.bucket;

        return [
          {
            workspaceId: doc._id,
            accountId: doc.accountId,
            name: doc.name,
            ...(typeof bucket === "string" ? { bucket: bucket } : {}),
            reason: error instanceof Error ? error.message : String(error),
          },
        ];
      }
    });

    return {
      violations: violations,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

export const create = internalMutation({
  args: {
    accountId: v.id("accounts"),
    name: v.string(),
    description: v.optional(v.string()),
    config: v.any(),
  },
  returns: v.id("workspaceConfigs"),
  handler: async (ctx, args): Promise<Id<"workspaceConfigs">> => {
    const account = await ctx.db.get(args.accountId);
    if (!account) {
      throw new Error(`Account not found: ${args.accountId}`);
    }

    const now = Date.now();

    return await ctx.db.insert("workspaceConfigs", {
      accountId: args.accountId,
      name: args.name,
      description: args.description,
      config: args.config,
      ...workspaceEnvRefFields(args.config),
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const update = internalMutation({
  args: {
    accountId: v.id("accounts"),
    workspaceId: v.string(),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    config: v.optional(v.any()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const { accountId, workspaceId, ...patch } = args;
    const normalized = ctx.db.normalizeId("workspaceConfigs", workspaceId);
    if (!normalized) {
      throw new ClientError(
        "Workspace config does not belong to the supplied accountId",
      );
    }
    const doc = await ctx.db.get(normalized);
    if (!doc || doc.accountId !== accountId) {
      throw new ClientError(
        "Workspace config does not belong to the supplied accountId",
      );
    }

    await ctx.db.patch(normalized, {
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.description !== undefined && {
        description: patch.description,
      }),
      ...(patch.config !== undefined && {
        config: patch.config,
        ...workspaceEnvRefFields(patch.config),
      }),
      updatedAt: Date.now(),
    });

    return null;
  },
});

export const remove = internalMutation({
  args: {
    accountId: v.id("accounts"),
    workspaceId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const normalized = ctx.db.normalizeId("workspaceConfigs", args.workspaceId);
    if (!normalized) {
      throw new ClientError(
        "Workspace config does not belong to the supplied accountId",
      );
    }
    const doc = await ctx.db.get(normalized);
    if (!doc || doc.accountId !== args.accountId) {
      throw new ClientError(
        "Workspace config does not belong to the supplied accountId",
      );
    }

    await ctx.db.delete(normalized);

    return null;
  },
});

/**
 * Scoped one-hour credentials for an R2 workspace, for core's sandbox mounts
 * and harness reads and for the Convex file actions. `prefix` may narrow the
 * workspace prefix (a partitioned folder), never leave it. A mutation, not a
 * query: a cached query result would hand back expired credentials.
 */
export const r2Credentials = internalMutation({
  args: {
    accountId: v.string(),
    workspaceId: v.string(),
    prefix: v.string(),
  },
  returns: v.object({
    accessKeyId: v.string(),
    secretAccessKey: v.string(),
    sessionToken: v.string(),
    expiration: v.string(),
  }),
  handler: async (ctx, args): Promise<R2Credentials> => {
    const id = ctx.db.normalizeId("workspaceConfigs", args.workspaceId);
    const workspace = id ? await ctx.db.get(id) : null;
    if (!workspace || workspace.accountId !== args.accountId)
      throw new Error("Workspace not found");
    const storage = normalizeWorkspaceConfig(workspace.config).storage;
    const auth = workspaceStorageOwnAuth(storage);
    if (auth?.type !== "r2" || !storage.bucket || !storage.endpoint)
      throw new Error("Workspace storage is not an R2 bucket");
    const base = normalizeWorkspacePrefix(storage.prefix);
    if (!args.prefix.startsWith(base))
      throw new Error("R2 credential prefix is outside the workspace prefix");
    // Normalization keeps both keys one `${NAME}` ref each.
    const refName = (reference: string): string => {
      const name = ACCOUNT_ENV_REF_PATTERN.exec(reference)?.[1];
      if (!name) throw new Error("R2 workspace key is not an env reference");

      return name;
    };
    const accessKeyName = refName(auth.accessKeyId);
    const secretName = refName(auth.secretAccessKey);
    const names = [...new Set([accessKeyName, secretName])];
    const { projectId, stageId } = workspace;
    const values =
      projectId && stageId
        ? await loadEnvironmentVariableValues(ctx, projectId, stageId, names)
        : await loadValuesForAccount(ctx, workspace.accountId, names);
    const resolve = (name: string): string => {
      const value = values[name];
      if (!value)
        throw new ClientError(
          `R2 workspace credential \${${name}} has no value; set it with ${projectId && stageId ? "broods env set" : "PUT /v1/env"}`,
        );

      return value;
    };

    return await createR2Credentials({
      endpoint: storage.endpoint,
      bucket: storage.bucket,
      prefix: args.prefix,
      accessKeyId: resolve(accessKeyName),
      secretAccessKey: resolve(secretName),
    });
  },
});
