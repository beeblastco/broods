/**
 * Dashboard-facing sandbox lifecycle actions. The dashboard reads instances via
 * `sandboxInstances.listForActiveOrg` (live) and drives suspend/resume/terminate
 * here. Each action proxies to broods's account-manage service endpoint with the
 * shared service-auth secret; broods owns the provider credentials + lifecycle
 * and writes the resulting status back into Convex. Mirrors `cronPublic.ts`.
 */

import { v } from "convex/values";
import { action, type ActionCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";

/**
 * Reads the broods account-manage base URL + service-auth secret from the env.
 * @returns the service URL and bearer secret.
 * @throws when either variable is unset.
 */
function getServiceEnv(): { url: string; secret: string } {
    const url = process.env.BROODS_ACCOUNT_MANAGE_URL;
    const secret = process.env.BROODS_SERVICE_AUTH_SECRET;
    if (!url || !secret) {
        throw new Error(
            "BROODS_ACCOUNT_MANAGE_URL or BROODS_SERVICE_AUTH_SECRET missing",
        );
    }

    return { url: url, secret: secret };
}

/**
 * Builds the service-auth headers broods expects on internal requests.
 * @param accountId the active account id (sent as X-Account-Id).
 * @param secret the shared service-auth bearer secret.
 * @returns the request headers.
 */
function headers(accountId: string, secret: string): HeadersInit {
    return {
        Authorization: `Bearer ${secret}`,
        "X-Account-Id": accountId,
        "Content-Type": "application/json",
    };
}

/**
 * Resolves the caller's active account and POSTs a sandbox lifecycle action to
 * broods. broods runs the provider call then writes the new status into Convex.
 * @param ctx the action context.
 * @param sandboxId the sandbox config the instance belongs to.
 * @param reservationKey the broods reconnection key identifying the instance.
 * @param op the lifecycle verb (suspend|resume|terminate).
 * @throws when no account resolves or broods returns a non-2xx response.
 */
async function callLifecycle(
    ctx: ActionCtx,
    sandboxId: string,
    reservationKey: string,
    op: "suspend" | "resume" | "terminate" | "snapshot",
    extra?: Record<string, unknown>,
): Promise<void> {
    const account = await ctx.runQuery(api.org.getActiveAccount, {});
    if (!account) throw new Error("No active org / account not provisioned");
    const controllable = await ctx.runQuery(internal.sandboxInstances.isControllable, {
        accountId: account.accountId as never,
        sandboxConfigId: sandboxId as never,
        reservationKey: reservationKey,
    });
    if (!controllable) {
        throw new Error("Sandbox instance does not belong to this sandbox config");
    }

    const { url, secret } = getServiceEnv();
    const res = await fetch(`${url}/accounts/me/sandboxes/${encodeURIComponent(sandboxId)}/${op}`, {
        method: "POST",
        headers: headers(account.accountId, secret),
        body: JSON.stringify({ reservationKey: reservationKey, ...extra }),
    });
    if (!res.ok) {
        throw new Error(`Broods sandbox ${op} failed: ${res.status} ${await res.text()}`);
    }
}

/**
 * Suspends a reserved sandbox instance, preserving disk+memory while freeing
 * compute.
 */
export const suspendSandbox = action({
    args: { sandboxId: v.id("sandboxConfigs"), reservationKey: v.string() },
    returns: v.null(),
    handler: async (ctx, args) => {
        await callLifecycle(ctx, args.sandboxId, args.reservationKey, "suspend");

        return null;
    },
});

/** Resumes a suspended sandbox instance. */
export const resumeSandbox = action({
    args: { sandboxId: v.id("sandboxConfigs"), reservationKey: v.string() },
    returns: v.null(),
    handler: async (ctx, args) => {
        await callLifecycle(ctx, args.sandboxId, args.reservationKey, "resume");

        return null;
    },
});

/** Terminates a sandbox instance and drops its reservation + registry row. */
export const terminateSandbox = action({
    args: { sandboxId: v.id("sandboxConfigs"), reservationKey: v.string() },
    returns: v.null(),
    handler: async (ctx, args) => {
        await callLifecycle(ctx, args.sandboxId, args.reservationKey, "terminate");

        return null;
    },
});

/** Captures a reusable snapshot/image from a running sandbox instance. */
export const createSnapshot = action({
    args: { sandboxId: v.id("sandboxConfigs"), reservationKey: v.string(), name: v.string() },
    returns: v.null(),
    handler: async (ctx, args) => {
        await callLifecycle(ctx, args.sandboxId, args.reservationKey, "snapshot", { name: args.name });

        return null;
    },
});
