/**
 * Direct CloudWatch Logs query — no caching, returns logs to client immediately.
 *
 * Required env vars:
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION
 *   CLOUDWATCH_LOG_GROUP_PREFIX  — e.g. "/aws/lambda/" (defaults to "/aws/lambda/")
 */

"use node";

import {
    CloudWatchLogsClient,
    FilterLogEventsCommand,
    GetQueryResultsCommand,
    StartQueryCommand,
} from "@aws-sdk/client-cloudwatch-logs";
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

const usageRange = v.union(
    v.literal("1h"),
    v.literal("3h"),
    v.literal("1d"),
    v.literal("7d"),
    v.literal("30d"),
    v.literal("1y"),
);

/** Time-bucketed token usage point grouped by model/provider. */
const usageBucket = v.object({
    bucketStart: v.number(),
    modelProvider: v.string(),
    modelId: v.string(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    reasoningTokens: v.number(),
    cachedInputTokens: v.number(),
    totalTokens: v.number(),
    invocations: v.number(),
    modelCalls: v.number(),
});

const usageStats = v.object({
    range: usageRange,
    binSeconds: v.number(),
    startTimeMs: v.number(),
    endTimeMs: v.number(),
    buckets: v.array(usageBucket),
    totals: v.object({
        inputTokens: v.number(),
        outputTokens: v.number(),
        reasoningTokens: v.number(),
        cachedInputTokens: v.number(),
        totalTokens: v.number(),
        invocations: v.number(),
        modelCalls: v.number(),
    }),
});

/**
 * Range -> lookback / bucket / Insights query window configuration.
 * Insights enforces a max of 10_000 returned rows, so coarse bins are required
 * for longer windows.
 */
const RANGE_CONFIG: Record<
    "1h" | "3h" | "1d" | "7d" | "30d" | "1y",
    { lookbackMs: number; binSeconds: number }
> = {
    "1h": { lookbackMs: 60 * 60 * 1000, binSeconds: 5 * 60 },
    "3h": { lookbackMs: 3 * 60 * 60 * 1000, binSeconds: 15 * 60 },
    "1d": { lookbackMs: 24 * 60 * 60 * 1000, binSeconds: 60 * 60 },
    "7d": { lookbackMs: 7 * 24 * 60 * 60 * 1000, binSeconds: 6 * 60 * 60 },
    "30d": { lookbackMs: 30 * 24 * 60 * 60 * 1000, binSeconds: 24 * 60 * 60 },
    "1y": { lookbackMs: 365 * 24 * 60 * 60 * 1000, binSeconds: 7 * 24 * 60 * 60 },
};

function makeClient(): CloudWatchLogsClient {
    return new CloudWatchLogsClient({
        region: process.env.AWS_REGION!,
        credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "",
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "",
        },
    });
}

async function fetchFromCloudWatch(opts: {
    functionName: string;
    startTimeMs: number;
    endTimeMs: number;
    limit: number;
    errorOnly: boolean;
}): Promise<Array<{
    timestamp: number;
    message: string;
    level: "INFO" | "WARN" | "ERROR" | "DEBUG";
    logGroup: string;
    logStream?: string;
    requestId?: string;
}>> {
    const logGroup = `/aws/lambda/${opts.functionName}`;
    const client = makeClient();

    const command = new FilterLogEventsCommand({
        logGroupName: logGroup,
        startTime: opts.startTimeMs,
        endTime: opts.endTimeMs,
        limit: opts.limit,
        ...(opts.errorOnly ? { filterPattern: '{ $.level = "ERROR" }' } : {}),
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
    // Logs are JSON lines from filthy-panty's logInfo/logError; prefer parsing.
    const trimmed = msg.trim();
    if (trimmed.startsWith("{")) {
        try {
            const parsed = JSON.parse(trimmed);
            const lvl = typeof parsed.level === "string" ? parsed.level.toUpperCase() : "";
            if (lvl === "ERROR" || lvl === "WARN" || lvl === "INFO" || lvl === "DEBUG") {
                return lvl;
            }
        } catch {
            // fall through to heuristic
        }
    }

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

/**
 * Run a CloudWatch Logs Insights query across multiple log groups and poll
 * until it completes. Returns the parsed rows as `{field -> value}` maps.
 */
async function runInsightsQuery(opts: {
    logGroupNames: string[];
    startTimeSec: number;
    endTimeSec: number;
    queryString: string;
}): Promise<Array<Record<string, string>>> {
    if (opts.logGroupNames.length === 0) {
        return [];
    }

    const client = makeClient();

    let queryId: string | undefined;
    try {
        const start = await client.send(
            new StartQueryCommand({
                logGroupNames: opts.logGroupNames,
                startTime: opts.startTimeSec,
                endTime: opts.endTimeSec,
                queryString: opts.queryString,
                limit: 10000,
            }),
        );
        queryId = start.queryId;
    } catch (err) {
        console.warn("CloudWatch Logs Insights StartQuery failed:", err);

        return [];
    }

    if (!queryId) {
        return [];
    }

    // Poll for results — Insights has no synchronous mode.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1000));

        let result;
        try {
            result = await client.send(new GetQueryResultsCommand({ queryId: queryId }));
        } catch (err) {
            console.warn("CloudWatch Logs Insights GetQueryResults failed:", err);

            return [];
        }

        const status = result.status ?? "Running";
        if (status === "Complete") {
            return (result.results ?? []).map((row) => {
                const out: Record<string, string> = {};
                for (const field of row) {
                    if (field.field) {
                        out[field.field] = field.value ?? "";
                    }
                }

                return out;
            });
        }
        if (status === "Failed" || status === "Cancelled" || status === "Timeout") {
            console.warn(`CloudWatch Logs Insights query ${status.toLowerCase()}`);

            return [];
        }
    }

    console.warn("CloudWatch Logs Insights query timed out client-side");

    return [];
}

export const fetchForProject = action({
    args: {
        projectId: v.id("projects"),
        lookbackMs: v.optional(v.number()),
        limit: v.optional(v.number()),
        errorOnly: v.optional(v.boolean()),
    },
    returns: v.array(logEntry),
    handler: async (ctx, args) => {
        const { projectId, lookbackMs, limit, errorOnly } = args;

        // Check authenticated user
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
                errorOnly: errorOnly ?? false,
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

/**
 * Aggregate token usage and model invocation counts from CloudWatch Logs Insights
 * for all deployments belonging to the requesting user's project.
 * @returns time-bucketed buckets grouped by (modelProvider, modelId) plus overall totals.
 */
export const fetchUsageStats = action({
    args: {
        projectId: v.id("projects"),
        range: usageRange,
    },
    returns: usageStats,
    handler: async (ctx, args) => {
        const { projectId, range } = args;

        // Check authenticated user
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) {
            throw new Error("User not found or not authenticated");
        }

        const cfg = RANGE_CONFIG[range];
        const nowMs = Date.now();
        const startMs = nowMs - cfg.lookbackMs;

        const empty = {
            range: range,
            binSeconds: cfg.binSeconds,
            startTimeMs: startMs,
            endTimeMs: nowMs,
            buckets: [],
            totals: {
                inputTokens: 0,
                outputTokens: 0,
                reasoningTokens: 0,
                cachedInputTokens: 0,
                totalTokens: 0,
                invocations: 0,
                modelCalls: 0,
            },
        };

        const deployments = await ctx.runQuery(internal.logsHelpers.getActiveDeploymentsInternal, {
            authId: authUser.id,
            projectId: projectId,
        });

        if (deployments.length === 0) {
            return empty;
        }

        const logGroupNames = deployments.map((d) => `/aws/lambda/${d.endpointId}`);

        // Single Insights query: bucket by time + (provider, model) and aggregate token usage.
        // Counts: `invocations` = model.invocation.finished (tasks),
        //         `modelCalls`  = model.step.finished (individual model calls).
        const queryString = `
fields @timestamp, eventType, modelProvider, modelId, usage.inputTokens, usage.outputTokens, usage.reasoningTokens, usage.cachedInputTokens, usage.totalTokens
| filter eventType = "model.invocation.finished" or eventType = "model.step.finished"
| stats
    sum(usage.inputTokens) as inputTokens,
    sum(usage.outputTokens) as outputTokens,
    sum(usage.reasoningTokens) as reasoningTokens,
    sum(usage.cachedInputTokens) as cachedInputTokens,
    sum(usage.totalTokens) as totalTokens,
    sum(eventType = "model.invocation.finished") as invocations,
    sum(eventType = "model.step.finished") as modelCalls
    by bin(${cfg.binSeconds}s) as bucketStart, modelProvider, modelId
| sort bucketStart asc
        `.trim();

        const rows = await runInsightsQuery({
            logGroupNames: logGroupNames,
            startTimeSec: Math.floor(startMs / 1000),
            endTimeSec: Math.floor(nowMs / 1000),
            queryString: queryString,
        });

        const buckets = rows.map((row) => {
            const bucketStart = parseBucketTimestamp(row.bucketStart);
            const inputTokens = toNum(row.inputTokens);
            const outputTokens = toNum(row.outputTokens);
            const reasoningTokens = toNum(row.reasoningTokens);
            const cachedInputTokens = toNum(row.cachedInputTokens);
            const totalTokens = toNum(row.totalTokens);
            const invocations = toNum(row.invocations);
            const modelCalls = toNum(row.modelCalls);

            return {
                bucketStart: bucketStart,
                modelProvider: row.modelProvider || "unknown",
                modelId: row.modelId || "unknown",
                inputTokens: inputTokens,
                outputTokens: outputTokens,
                reasoningTokens: reasoningTokens,
                cachedInputTokens: cachedInputTokens,
                totalTokens: totalTokens,
                invocations: invocations,
                modelCalls: modelCalls,
            };
        });

        const totals = buckets.reduce(
            (acc, b) => {
                acc.inputTokens += b.inputTokens;
                acc.outputTokens += b.outputTokens;
                acc.reasoningTokens += b.reasoningTokens;
                acc.cachedInputTokens += b.cachedInputTokens;
                acc.totalTokens += b.totalTokens;
                acc.invocations += b.invocations;
                acc.modelCalls += b.modelCalls;

                return acc;
            },
            {
                inputTokens: 0,
                outputTokens: 0,
                reasoningTokens: 0,
                cachedInputTokens: 0,
                totalTokens: 0,
                invocations: 0,
                modelCalls: 0,
            },
        );

        return {
            range: range,
            binSeconds: cfg.binSeconds,
            startTimeMs: startMs,
            endTimeMs: nowMs,
            buckets: buckets,
            totals: totals,
        };
    },
});

function toNum(value: string | undefined): number {
    if (!value) return 0;
    const n = Number(value);

    return Number.isFinite(n) ? n : 0;
}

/**
 * Parse the `bucketStart` value returned by Insights `bin()`, which is a UTC
 * timestamp string like `"2026-05-21 14:00:00.000"`.
 * @returns epoch milliseconds.
 */
function parseBucketTimestamp(value: string | undefined): number {
    if (!value) return 0;
    // Insights returns "YYYY-MM-DD HH:mm:ss.SSS" in UTC.
    const iso = value.includes("T") ? value : value.replace(" ", "T") + "Z";
    const ms = Date.parse(iso);

    return Number.isFinite(ms) ? ms : 0;
}
