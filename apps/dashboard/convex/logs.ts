/**
 * Direct CloudWatch Logs query — no caching, returns logs to client immediately.
 *
 * Required env vars:
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION
 *   CLOUDWATCH_LOG_GROUP_PREFIX  — e.g. "/aws/lambda/" (defaults to "/aws/lambda/")
 */

"use node";

import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action } from "./_generated/server";
import { authKit } from "./auth";

const logEntry = v.object({
    timestamp: v.number(),
    message: v.string(),
    level: v.union(
        v.literal("INFO"),
        v.literal("WARN"),
        v.literal("ERROR"),
        v.literal("DEBUG"),
    ),
    logGroup: v.string(),
    logStream: v.optional(v.string()),
    functionName: v.string(),
    requestId: v.optional(v.string()),
});

async function fetchFromCloudWatch(opts: {
    functionName: string;
    startTimeMs: number;
    endTimeMs: number;
    limit: number;
}): Promise<Array<{
    timestamp: number;
    message: string;
    level: "INFO" | "WARN" | "ERROR" | "DEBUG";
    logGroup: string;
    logStream?: string;
    requestId?: string;
}>> {
    const region = process.env.AWS_REGION ?? "us-east-1";
    const logGroupPrefix = process.env.CLOUDWATCH_LOG_GROUP_PREFIX ?? "/aws/lambda/";
    const logGroup = `${logGroupPrefix}${opts.functionName}`;

    const client = new CloudWatchLogsClient({
        region: region,
        credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "",
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "",
        },
    });

    const command = new FilterLogEventsCommand({
        logGroupName: logGroup,
        startTime: opts.startTimeMs,
        endTime: opts.endTimeMs,
        limit: opts.limit,
    });

    let response;
    try {
        response = await client.send(command);
    } catch (err) {
        console.warn(`CloudWatch log group ${logGroup} not found or inaccessible:`, err);
        return [];
    }

    const events = response.events ?? [];

    return events.map((event) => {
        const msg = event.message ?? "";
        const level = detectLogLevel(msg);
        const requestId = extractRequestId(msg);

        return {
            timestamp: event.timestamp ?? Date.now(),
            message: msg.trim(),
            level: level,
            logGroup: logGroup,
            logStream: event.logStreamName,
            requestId: requestId,
        };
    });
}

function detectLogLevel(msg: string): "INFO" | "WARN" | "ERROR" | "DEBUG" {
    const upper = msg.toUpperCase();
    if (upper.includes("[ERROR]") || upper.includes("ERROR") || upper.startsWith("ERROR")) return "ERROR";
    if (upper.includes("[WARN]") || upper.includes("WARNING") || upper.startsWith("WARN")) return "WARN";
    if (upper.includes("[DEBUG]") || upper.startsWith("DEBUG")) return "DEBUG";
    return "INFO";
}

function extractRequestId(msg: string): string | undefined {
    const match = msg.match(/RequestId:\s*([a-f0-9-]{36})/i);
    return match ? match[1] : undefined;
}

export const fetchForProject = action({
    args: {
        projectId: v.id("projects"),
        lookbackMs: v.optional(v.number()),
        limit: v.optional(v.number()),
    },
    returns: v.array(logEntry),
    handler: async (ctx, args) => {
        const { projectId, lookbackMs, limit } = args;

        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) {
            return [];
        }

        const now = Date.now();
        const startTime = now - (lookbackMs ?? 60 * 60 * 1000);

        const deployments = await ctx.runQuery(internal.logsHelpers.getActiveDeploymentsInternal, {
            authId: authUser.id,
            projectId: projectId,
        });

        if (deployments.length === 0) {
            return [];
        }

        const allLogs: Array<{
            timestamp: number;
            message: string;
            level: "INFO" | "WARN" | "ERROR" | "DEBUG";
            logGroup: string;
            logStream?: string;
            functionName: string;
            requestId?: string;
        }> = [];

        for (const deployment of deployments) {
            const entries = await fetchFromCloudWatch({
                functionName: deployment.endpointId,
                startTimeMs: startTime,
                endTimeMs: now,
                limit: limit ?? 100,
            });

            for (const entry of entries) {
                allLogs.push({
                    ...entry,
                    functionName: deployment.endpointId,
                });
            }
        }

        allLogs.sort((a, b) => b.timestamp - a.timestamp);

        return allLogs;
    },
});
