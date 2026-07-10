"use node";

/**
 * Node-runtime WorkOS cleanup. Core removes runtime and AWS resources while
 * account configuration exists; transient failures are retried before finalizing.
 */

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";

/** Runs idempotent runtime cleanup followed by the final Convex user purge. */
export const run = internalAction({
    args: { authId: v.string() },
    returns: v.null(),
    handler: async (ctx, args) => {
        const accountIds: Id<"accounts">[] = await ctx.runQuery(internal.workosUserDeletion.listSoleOwnedAccounts, {
            authId: args.authId,
        });
        const url = process.env.BROODS_ACCOUNT_MANAGE_URL?.replace(/\/+$/, "");
        const secret = process.env.ADMIN_ACCOUNT_SECRET;

        let cleanupSucceeded = Boolean(url && secret);
        if (!url || !secret) {
            console.error(
                "WorkOS user deletion skipped core runtime cleanup: BROODS_ACCOUNT_MANAGE_URL or ADMIN_ACCOUNT_SECRET is missing",
            );
        } else {
            for (const accountId of accountIds) {
                try {
                    const response = await fetch(`${url}/accounts/${encodeURIComponent(accountId)}`, {
                        method: "DELETE",
                        headers: { Authorization: `Bearer ${secret}` },
                    });
                    // A repeated delivery can find the account already gone.
                    if (!response.ok && response.status !== 404) {
                        cleanupSucceeded = false;
                        console.error(
                            `WorkOS user deletion core cleanup failed for account ${accountId}: ${response.status} ${await response.text()}`,
                        );
                    }
                } catch (error) {
                    cleanupSucceeded = false;
                    console.error(`WorkOS user deletion core cleanup failed for account ${accountId}`, error);
                }
            }
        }

        if (!cleanupSucceeded) {
            const delayMs: number | null = await ctx.runMutation(internal.workosUserDeletion.scheduleRetry, {
                authId: args.authId,
            });
            if (delayMs !== null) {
                await ctx.scheduler.runAfter(delayMs, internal.workosUserDeletionCleanup.run, {
                    authId: args.authId,
                });
            }

            return null;
        }

        await ctx.runMutation(internal.workosUserDeletion.finalize, {
            authId: args.authId,
        });

        return null;
    },
});
