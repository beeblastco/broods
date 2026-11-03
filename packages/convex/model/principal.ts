import { v, type Infer } from "convex/values";

export const RUN_TOKEN_PREFIX = "brt_";

export const principalLinkValidator = v.union(
  v.object({
    kind: v.literal("user"),
    id: v.string(),
    name: v.optional(v.string()),
    channel: v.optional(v.string()),
  }),
  v.object({
    kind: v.literal("api"),
    keyKind: v.union(
      v.literal("account"),
      v.literal("deployment"),
      v.literal("cron"),
    ),
  }),
  v.object({ kind: v.literal("agent"), agentId: v.string() }),
);

export type PrincipalLink = Infer<typeof principalLinkValidator>;
