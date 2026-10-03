/**
 * The delegation chain behind an agent run: the person or key that asked,
 * then every agent that delegated on the way. Core builds the chain per run
 * (shared/domain/principal.ts) and the audit ledger stores it on run and
 * tool-denial rows, so one link shape lives here for both sides.
 */

import { v, type Infer } from "convex/values";

/** Bearer prefix of the run token core mints for one run. The config plane refuses it. */
export const RUN_TOKEN_PREFIX = "fp_run_";

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
