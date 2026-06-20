/**
 * Sends low-volume Convex service audit events through account-manage so they
 * share the runtime's NATS live stream and durable OTLP/Loki pipeline.
 */

import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { internalAction, type MutationCtx } from "./_generated/server";

interface ServiceLogInput {
    projectId: Id<"projects">;
    environmentId: Id<"environments">;
    eventType: string;
    message: string;
    agentId?: string;
    data?: Record<string, unknown>;
}

/** Queue one service event only when the environment has an active deployment. */
export async function scheduleServiceLog(ctx: MutationCtx, input: ServiceLogInput): Promise<void> {
    const deployment = await ctx.db
        .query("agentDeployments")
        .withIndex("by_projectId_and_environmentId_and_status", (q) =>
            q
                .eq("projectId", input.projectId)
                .eq("environmentId", input.environmentId)
                .eq("status", "active"),
        )
        .unique();
    if (!deployment) return;

    await ctx.scheduler.runAfter(0, internal.observability.emitServiceLog, {
        accountId: deployment.accountId,
        project: deployment.projectSlug,
        environment: deployment.environmentSlug,
        endpointId: deployment.endpointId,
        eventType: input.eventType,
        message: input.message,
        agentId: input.agentId,
        data: input.data,
    });
}

/** Forward a scheduled audit event to the scoped core service endpoint. */
export const emitServiceLog = internalAction({
    args: {
        accountId: v.id("accounts"),
        project: v.string(),
        environment: v.string(),
        endpointId: v.string(),
        eventType: v.string(),
        message: v.string(),
        agentId: v.optional(v.string()),
        data: v.optional(v.any()),
    },
    returns: v.null(),
    handler: async (_ctx, args) => {
        const baseUrl = process.env.FILTHY_PANTY_ACCOUNT_MANAGE_URL?.replace(/\/+$/, "");
        const serviceSecret = process.env.FILTHY_PANTY_SERVICE_AUTH_SECRET;
        if (!baseUrl || !serviceSecret) return null;

        const response = await fetch(`${baseUrl}/v1/internal/observability-log`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${serviceSecret}`,
                "content-type": "application/json",
                "x-account-id": args.accountId,
            },
            body: JSON.stringify({
                project: args.project,
                environment: args.environment,
                endpointId: args.endpointId,
                eventType: args.eventType,
                message: args.message,
                agentId: args.agentId,
                data: args.data,
            }),
        });
        if (!response.ok) {
            throw new Error(`Observability service returned HTTP ${response.status}`);
        }

        return null;
    },
});
