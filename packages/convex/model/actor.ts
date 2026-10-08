/**
 * Who did something, as a list draws it: a name and an avatar behind a user
 * id. Every "created by", "rotated by" and "invited by" cell reads this
 * shape, so the queries behind them share one resolver.
 */

import { v, type Infer } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export const actorValidator = v.object({
  name: v.string(),
  avatarUrl: v.optional(v.string()),
});

export type Actor = Infer<typeof actorValidator>;

type Ctx = QueryCtx | MutationCtx;

/** One actor; undefined when there is no id or the user is gone. */
export async function actorOf(
  ctx: Ctx,
  userId: Id<"users"> | undefined,
): Promise<Actor | undefined> {
  if (!userId) return undefined;
  const user = await ctx.db.get(userId);

  return user ? { name: user.name, avatarUrl: user.avatarUrl } : undefined;
}

/** Several actors by id, each user fetched once; gone users are absent. */
export async function actorsOf(
  ctx: Ctx,
  userIds: Iterable<Id<"users"> | undefined>,
): Promise<Map<Id<"users">, Actor>> {
  const ids = [...new Set(userIds)].filter(
    (id): id is Id<"users"> => id !== undefined,
  );
  const users = await Promise.all(ids.map((id) => ctx.db.get(id)));
  const actors = new Map<Id<"users">, Actor>();
  for (const user of users) {
    if (user)
      actors.set(user._id, { name: user.name, avatarUrl: user.avatarUrl });
  }

  return actors;
}
