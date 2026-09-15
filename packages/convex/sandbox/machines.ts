/**
 * Connection state of `machine` sandboxes. Core holds each `broods machine`
 * daemon's socket and mirrors its connect, a heartbeat every minute and its
 * disconnect here, so the dashboard can list the computer beside the cloud
 * instances. `connectionId` changes on every connect: a replaced socket's late
 * heartbeat or disconnect names the old id and changes nothing.
 */

import { v, type ObjectType } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalMutation,
  query,
  type MutationCtx,
} from "../_generated/server";
import { getActiveAccountForUser } from "../org/orgs";
import { machineConnectionsFields } from "../schema";

const connectionRef = {
  accountId: v.id("accounts"),
  sandboxConfigId: v.id("sandboxConfigs"),
  connectionId: v.string(),
};

const namedConnection = v.object({
  ...machineConnectionsFields,
  _id: v.id("machineConnections"),
  _creationTime: v.number(),
  name: v.string(),
});

type ConnectionRef = ObjectType<typeof connectionRef>;

type NamedConnection = Doc<"machineConnections"> & { name: string };

/** A daemon claimed its sandbox; it takes the row over from any earlier connection. */
export const connected = internalMutation({
  args: {
    ...connectionRef,
    hostname: machineConnectionsFields.hostname,
    platform: machineConnectionsFields.platform,
    computer: machineConnectionsFields.computer,
    mcp: machineConnectionsFields.mcp,
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const config = await ctx.db.get(args.sandboxConfigId);
    if (!config || config.accountId !== args.accountId) return null;
    const now = Date.now();
    const row = {
      ...args,
      projectId: config.projectId,
      stageId: config.stageId,
      connectedAt: now,
      lastSeenAt: now,
      disconnectedAt: undefined,
    };
    const existing = await connectionFor(ctx, args.sandboxConfigId);
    if (existing) {
      await ctx.db.patch(existing._id, row);
    } else {
      await ctx.db.insert("machineConnections", row);
    }

    return null;
  },
});

export const disconnected = internalMutation({
  args: connectionRef,
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const row = await heldConnection(ctx, args);
    if (row) await ctx.db.patch(row._id, { disconnectedAt: Date.now() });

    return null;
  },
});

/** The stage's computers that ever connected, named after their current sandbox config. */
export const listForActiveOrg = query({
  args: {
    projectId: v.id("projects"),
    stageId: v.id("stages"),
  },
  returns: v.array(namedConnection),
  handler: async (ctx, args): Promise<NamedConnection[]> => {
    const account = await getActiveAccountForUser(ctx);
    if (!account) return [];
    const rows = await ctx.db
      .query("machineConnections")
      .withIndex("by_accountId_projectId_and_stageId", (q) =>
        q
          .eq("accountId", account._id)
          .eq("projectId", args.projectId)
          .eq("stageId", args.stageId),
      )
      .take(100);
    const named = await Promise.all(
      rows.map(async (row): Promise<NamedConnection | null> => {
        const config = await ctx.db.get(row.sandboxConfigId);

        return config ? { ...row, name: config.name } : null;
      }),
    );

    return named.filter((row): row is NamedConnection => row !== null);
  },
});

export const seen = internalMutation({
  args: connectionRef,
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const row = await heldConnection(ctx, args);
    if (row) await ctx.db.patch(row._id, { lastSeenAt: Date.now() });

    return null;
  },
});

async function connectionFor(
  ctx: MutationCtx,
  sandboxConfigId: Id<"sandboxConfigs">,
): Promise<Doc<"machineConnections"> | null> {
  return await ctx.db
    .query("machineConnections")
    .withIndex("by_sandboxConfigId", (q) =>
      q.eq("sandboxConfigId", sandboxConfigId),
    )
    .unique();
}

// The row, only while this connection still holds it.
async function heldConnection(
  ctx: MutationCtx,
  ref: ConnectionRef,
): Promise<Doc<"machineConnections"> | null> {
  const row = await connectionFor(ctx, ref.sandboxConfigId);

  return row?.accountId === ref.accountId &&
    row.connectionId === ref.connectionId
    ? row
    : null;
}
