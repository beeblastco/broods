/**
 * Sandbox snapshot/image registry. Mirrors broods's image build state so the
 * dashboard can list snapshots with their unified build status, and locks each
 * snapshot to the account and stage of the sandbox it was taken from.
 * `listForActiveOrg` is the dashboard read; `upsert` is the create-or-refresh
 * writer broods calls when a snapshot is captured (or its build status changes);
 * `findByImage` is how core checks a sandbox may boot the image it pins, and
 * `assertSnapshotInScope` is the same check on every config write that points
 * a sandbox at a snapshot.
 */

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
import { snapshotBootRefusal, type SandboxScope } from "../model/sandboxRules";
import {
  sandboxSnapshotScopeValidator,
  sandboxSnapshotsFields,
} from "../schema";

const sandboxSnapshotListRow = v.object({
  ...sandboxSnapshotsFields,
  _id: v.id("sandboxSnapshots"),
  _creationTime: v.number(),
  /** The stage the snapshot was taken on, for the dashboard to show. */
  stageName: v.optional(v.string()),
});

/**
 * Public query: lists sandbox snapshots/images for the caller's active org,
 * each with the name of the stage it was taken on. Used by the dashboard
 * Sandbox tab's Snapshots view and the sandbox node's Snapshot picker.
 * @returns the account's snapshot rows, or `[]` when no org/account resolves.
 */
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

/**
 * Internal query: the snapshot row for one provider image, so core can refuse
 * to boot a snapshot of another account or stage and read the variant it was
 * built from. Image ids are unique per capture, so a row of another account
 * comes back too: core must refuse it, not boot it as a provider image.
 * @returns the row's owner, scope, base image and status, or null when no
 * account registered the image (a provider image, not a Broods snapshot)
 */
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

/**
 * Internal query for the config HTTP actions: `assertSnapshotInScope`, which
 * throws its refusal as a client error (400).
 */
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

/**
 * Refuses a config write that points a sandbox of `scope` at a registered
 * snapshot it could not boot: another account's, another stage's, or one
 * taken before snapshots recorded their stage. A name no account registered
 * is a provider image and passes.
 * @param ctx query or mutation context
 * @param accountId the sandbox config's account
 * @param scope the sandbox config's scope
 * @param snapshot the config's `snapshot`, when it sets one
 */
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

/**
 * Create-or-refresh a snapshot/image row, keyed by (account, scope, name).
 * Called by broods when a snapshot is captured from a running sandbox or when
 * the image pipeline reports a build-status transition.
 * @param accountId the owning account.
 * @param scope the stage (or account) of the sandbox the snapshot was taken from.
 * @param name the snapshot name (unique per account and scope).
 * @param provider the sandbox compute backend the image targets.
 * @param baseImage the base image/template the snapshot derived from.
 * @param externalImageId the provider-side image id/ARN.
 * @param status the unified build status; defaults to `active`.
 */
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
    // The same name on another stage is another snapshot: a dev capture must
    // never repoint the row a production sandbox boots from.
    const existing = named.find(
      (row) =>
        snapshotBootRefusal(row, {
          accountId: args.accountId,
          scope: args.scope,
        }) === null,
    );

    // Pinned configs name the provider image, so repointing a name at another
    // provider's image would strand every sandbox booting the old one.
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

// Records which account and stage took an image, once: the first capture owns it.
async function lockImage(
  ctx: MutationCtx,
  image: Omit<Doc<"sandboxSnapshotImages">, "_id" | "_creationTime">,
): Promise<void> {
  const locked = await ctx.db
    .query("sandboxSnapshotImages")
    .withIndex("by_externalImageId", (q) =>
      q.eq("externalImageId", image.externalImageId),
    )
    .first();
  if (locked) return;
  await ctx.db.insert("sandboxSnapshotImages", {
    externalImageId: image.externalImageId,
    accountId: image.accountId,
    scope: image.scope,
    baseImage: image.baseImage,
  });
}

type SnapshotImage = Pick<
  Doc<"sandboxSnapshots">,
  "accountId" | "scope" | "baseImage" | "status"
>;

// The row registering one provider image, the caller's own first should two
// accounts ever hold the same id. An image whose row moved on to a newer
// capture, or whose account is gone, still answers from its lock, as inactive.
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
