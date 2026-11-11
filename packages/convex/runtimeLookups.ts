// Every agent turn and config-plane request reads these, and Convex loads a file's whole
// import graph per call: import only the schema here.
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalQuery } from "./_generated/server";
import { accountDoc } from "./model/accountDoc";
import { agentDoc } from "./model/agentDoc";
import { sandboxConfigDoc } from "./model/sandboxConfigDoc";

export const accountBySecretHash = internalQuery({
  args: { secretHash: v.string() },
  returns: v.union(accountDoc, v.null()),
  handler: async (ctx, args): Promise<Doc<"accounts"> | null> => {
    return await ctx.db
      .query("accounts")
      .withIndex("by_secretHash", (q) => q.eq("secretHash", args.secretHash))
      .unique();
  },
});

// `v.string()`, not `v.id`: an unknown id resolves to null instead of failing validation.
export const agentById = internalQuery({
  args: {
    accountId: v.id("accounts"),
    agentId: v.string(),
  },
  returns: v.union(agentDoc, v.null()),
  handler: async (ctx, args): Promise<Doc<"agents"> | null> => {
    const normalized = ctx.db.normalizeId("agents", args.agentId);
    if (!normalized) return null;
    const agent = await ctx.db.get(normalized);
    if (!agent || agent.accountId !== args.accountId) {
      return null;
    }

    return agent;
  },
});

export const sandboxConfigById = internalQuery({
  args: {
    accountId: v.id("accounts"),
    sandboxId: v.string(),
  },
  returns: v.union(sandboxConfigDoc, v.null()),
  handler: async (ctx, args): Promise<Doc<"sandboxConfigs"> | null> => {
    const normalized = ctx.db.normalizeId("sandboxConfigs", args.sandboxId);
    if (!normalized) return null;
    const doc = await ctx.db.get(normalized);
    if (!doc || doc.accountId !== args.accountId) return null;

    return doc;
  },
});
