import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { getActiveAccountForUser } from "../org/orgs";
import { ClientError } from "../model/clientError";
import { lockImage } from "../model/snapshotLocks";
import { snapshotBootRefusal, type SandboxScope } from "../model/sandboxRules";
import {
  sandboxSnapshotScopeValidator,
  sandboxSnapshotsFields,
} from "../schema";

const sandboxSnapshotListRow = v.object({
  ...sandboxSnapshotsFields,
  _id: v.id("sandboxSnapshots"),
  _creationTime: v.number(),
  stageName: v.optional(v.string()),
});

export const listForActiveOrg = query({
  args: {},
  returns: v.array(sandboxSnapshotListRow),
  handler: async (
    ctx,
  ): Promise<Array<Doc<"sandboxSnapshots"> & { stageName?: string }>> => {
    const account = await getActiveAccountForUser(ctx);
    if (!account) return [];

    const rows = await ctx.db
      .query("sandboxSnapshots")
      .withIndex("by_accountId_and_name", (q) => q.eq("accountId", account._id))
      .collect();
    const stageIds = new Set(
      rows.flatMap((row) =>
        typeof row.scope === "object" ? [row.scope.stageId] : [],
      ),
    );
    const stageNames = new Map(
      await Promise.all(
        [...stageIds].map(
          async (stageId) =>
            [stageId, (await ctx.db.get(stageId))?.name] as const,
        ),
      ),
    );

    return rows.map((row) => {
      const stageName =
        typeof row.scope === "object"
          ? stageNames.get(row.scope.stageId)
          : undefined;

      return stageName ? { ...row, stageName: stageName } : row;
    });
  },
});

// Another account's row comes back too: core must refuse it, not boot it as a provider
// image. null means no account registered the image.
export const findByImage = internalQuery({
  args: {
    accountId: v.optional(v.id("accounts")),
    externalImageId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      accountId: v.id("accounts"),
      scope: v.optional(sandboxSnapshotScopeValidator),
      baseImage: v.string(),
      status: sandboxSnapshotsFields.status,
    }),
  ),
  handler: async (ctx, args): Promise<SnapshotImage | null> => {
    const row = await snapshotByImage(
      ctx,
      args.accountId,
      args.externalImageId,
    );

    return row
      ? {
          accountId: row.accountId,
          ...(row.scope ? { scope: row.scope } : {}),
          baseImage: row.baseImage,
          status: row.status,
        }
      : null;
  },
});

export const assertInScope = internalQuery({
  args: {
    accountId: v.id("accounts"),
    scope: sandboxSnapshotScopeValidator,
    snapshot: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await assertSnapshotInScope(ctx, args.accountId, args.scope, args.snapshot);

    return null;
  },
});

// A name no account registered is a provider image and passes.
export async function assertSnapshotInScope(
  ctx: QueryCtx | MutationCtx,
  accountId: Id<"accounts">,
  scope: SandboxScope,
  snapshot: unknown,
): Promise<void> {
  if (typeof snapshot !== "string" || !snapshot) return;
  // A MicroVM image is registered by name, whatever version its ARN pins.
  const image = snapshot.includes(":microvm-image:")
    ? snapshot.split(":").slice(0, 7).join(":")
    : snapshot;
  const row = await snapshotByImage(ctx, accountId, image);
  const refusal = row
    ? snapshotBootRefusal(row, { accountId: accountId, scope: scope })
    : null;
  if (refusal) throw new ClientError(refusal);
}

export const upsert = internalMutation({
  args: {
    accountId: v.id("accounts"),
    scope: sandboxSnapshotScopeValidator,
    name: v.string(),
    provider: sandboxSnapshotsFields.provider,
    baseImage: v.string(),
    externalImageId: v.string(),
    status: v.optional(sandboxSnapshotsFields.status),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const named = await ctx.db
      .query("sandboxSnapshots")
      .withIndex("by_accountId_and_name", (q) =>
        q.eq("accountId", args.accountId).eq("name", args.name),
      )
      .collect();
    // The same name on another stage is another snapshot: dev must never repoint prod's.
    const existing = named.find(
      (row) =>
        snapshotBootRefusal(row, {
          accountId: args.accountId,
          scope: args.scope,
        }) === null,
    );

    // Configs pin the provider image: another provider's would strand their sandboxes.
    if (existing && existing.provider !== args.provider) {
      throw new ClientError(
        `snapshot name "${args.name}" is already a ${existing.provider} snapshot; pick another name`,
        "conflict",
      );
    }
    const now = Date.now();
    const status = args.status ?? "active";
    // A re-capture moves the row to the new image; the old one keeps its lock.
    if (existing && existing.externalImageId !== args.externalImageId) {
      await lockImage(ctx, {
        ...existing,
        scope: args.scope,
      });
    }
    await lockImage(ctx, args);
    if (existing) {
      await ctx.db.patch(existing._id, {
        provider: args.provider,
        baseImage: args.baseImage,
        externalImageId: args.externalImageId,
        status: status,
        lastUsedAt: now,
      });

      return null;
    }

    await ctx.db.insert("sandboxSnapshots", {
      accountId: args.accountId,
      scope: args.scope,
      name: args.name,
      provider: args.provider,
      baseImage: args.baseImage,
      externalImageId: args.externalImageId,
      status: status,
      pulledCount: 0,
      createdAt: now,
      lastUsedAt: now,
    });

    return null;
  },
});

type SnapshotImage = Pick<
  Doc<"sandboxSnapshots">,
  "accountId" | "scope" | "baseImage" | "status"
>;

// The caller's own row first, should two accounts share an id. An image whose row moved
// on, or whose account is gone, still answers from its lock, as inactive.
async function snapshotByImage(
  ctx: QueryCtx | MutationCtx,
  accountId: Id<"accounts"> | undefined,
  externalImageId: string,
): Promise<SnapshotImage | null> {
  const own = accountId
    ? await ctx.db
        .query("sandboxSnapshots")
        .withIndex("by_externalImageId_and_accountId", (q) =>
          q.eq("externalImageId", externalImageId).eq("accountId", accountId),
        )
        .first()
    : null;
  const row =
    own ??
    (await ctx.db
      .query("sandboxSnapshots")
      .withIndex("by_externalImageId_and_accountId", (q) =>
        q.eq("externalImageId", externalImageId),
      )
      .first());
  if (row) return row;
  const lock = await ctx.db
    .query("sandboxSnapshotImages")
    .withIndex("by_externalImageId", (q) =>
      q.eq("externalImageId", externalImageId),
    )
    .first();

  return lock ? { ...lock, status: "inactive" } : null;
}
