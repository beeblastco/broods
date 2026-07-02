/**
 * Dashboard-facing sandbox lifecycle actions. The dashboard reads instances via
 * `sandboxInstances.listForActiveOrg` (live) and drives suspend/resume/terminate
 * plus bounded terminal commands here. Each action proxies to broods's account-
 * manage service endpoint with the shared service-auth secret; broods owns the
 * provider credentials + lifecycle and writes the resulting status back into Convex.
 * Mirrors `cronPublic.ts`.
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

    return { url: url.replace(/\/+$/, ""), secret: secret };
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
    op: "suspend" | "resume" | "terminate" | "snapshot" | "refresh" | "exec" | "terminal",
    extra?: Record<string, unknown>,
): Promise<unknown> {
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
    if (res.status === 404 && op === "refresh") {
        // The sandbox config behind this instance row was deleted, so broods can
        // no longer act on it. Drop the orphaned mirror row so the dashboard
        // heals on refresh instead of erroring forever.
        await ctx.runMutation(internal.sandboxInstances.remove, {
            accountId: account.accountId as never,
            reservationKey: reservationKey,
        });

        return null;
    }
    if (!res.ok) {
        throw new Error(`Broods sandbox ${op} failed: ${res.status} ${await res.text()}`);
    }

    const text = await res.text();
    if (!text) return null;

    return JSON.parse(text);
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

/** Refreshes the mirrored instance state from the provider control plane. */
export const refreshSandbox = action({
    args: { sandboxId: v.id("sandboxConfigs"), reservationKey: v.string() },
    returns: v.null(),
    handler: async (ctx, args) => {
        await callLifecycle(ctx, args.sandboxId, args.reservationKey, "refresh");

        return null;
    },
});

/**
 * Mints a short-lived sealed ticket for a live PTY terminal on a reserved
 * sandbox instance. The browser passes the opaque token to the public gateway's
 * terminal WebSocket; broods resumes a suspended instance first when needed.
 */
export const openTerminal = action({
    args: { sandboxId: v.id("sandboxConfigs"), reservationKey: v.string() },
    returns: v.object({
        token: v.string(),
        expiresAt: v.number(),
        websocketPath: v.string(),
    }),
    handler: async (ctx, args) => {
        const result = await callLifecycle(ctx, args.sandboxId, args.reservationKey, "terminal");
        if (!result || typeof result !== "object") {
            throw new Error("Broods sandbox terminal returned an empty response");
        }
        const record = result as Record<string, unknown>;
        if (typeof record.token !== "string" || typeof record.expiresAt !== "number" || typeof record.websocketPath !== "string") {
            throw new Error("Broods sandbox terminal returned an invalid ticket");
        }

        return {
            token: record.token,
            expiresAt: record.expiresAt,
            websocketPath: record.websocketPath,
        };
    },
});

/** Runs one bounded shell command against a reserved sandbox instance. */
export const runSandboxCommand = action({
    args: {
        sandboxId: v.id("sandboxConfigs"),
        reservationKey: v.string(),
        code: v.string(),
    },
    returns: v.object({
        ok: v.boolean(),
        runtime: v.string(),
        exitCode: v.union(v.number(), v.null()),
        stdout: v.string(),
        stderr: v.string(),
        durationMs: v.number(),
        truncated: v.boolean(),
        provider: v.string(),
    }),
    handler: async (ctx, args) => {
        const result = await callLifecycle(ctx, args.sandboxId, args.reservationKey, "exec", {
            code: args.code,
            timeoutSeconds: 30,
            outputLimitBytes: 64 * 1024,
        });
        if (!result || typeof result !== "object") {
            throw new Error("Broods sandbox exec returned an empty response");
        }
        const record = result as Record<string, unknown>;

        return {
            ok: record.ok === true,
            runtime: typeof record.runtime === "string" ? record.runtime : "bash",
            exitCode: typeof record.exitCode === "number" ? record.exitCode : null,
            stdout: typeof record.stdout === "string" ? record.stdout : "",
            stderr: typeof record.stderr === "string" ? record.stderr : "",
            durationMs: typeof record.durationMs === "number" ? record.durationMs : 0,
            truncated: record.truncated === true,
            provider: typeof record.provider === "string" ? record.provider : "sandbox",
        };
    },
});
