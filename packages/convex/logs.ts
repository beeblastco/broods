/**
 * Direct CloudWatch Logs queries for deployment logs and token-usage stats.
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
import type { Id } from "./_generated/dataModel";
import { action, internalAction } from "./_generated/server";
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

type LogEntry = {
    timestamp: number;
    message: string;
    level: "INFO" | "WARN" | "ERROR" | "DEBUG";
    logGroup: string;
    logStream?: string;
    functionName: string;
    requestId?: string;
};

type LogSource = {
    logGroup: string;
    functionName: string;
};

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

// Insights caps results at 10_000 rows, so longer windows need coarser bins.
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

/**
 * Returns the filthy-panty harness function's CloudWatch log group, if
 * configured. Set FILTHY_PANTY_HARNESS_LOG_GROUP in Convex env to e.g.
 * `/aws/lambda/filthy-panty-harness-processing-us-east-1-123456789012`
 * (production) or `/aws/lambda/dev-filthy-panty-harness-processing-...` (dev).
 */
function getFilthyPantyLogGroup(): string | null {
    const raw = process.env.FILTHY_PANTY_HARNESS_LOG_GROUP?.trim();
    if (!raw) return null;
    return raw.startsWith("/aws/lambda/") ? raw : `/aws/lambda/${raw}`;
}

async function fetchFromCloudWatch(opts: {
    functionName: string;
    startTimeMs: number;
    endTimeMs: number;
    limit: number;
    errorOnly: boolean;
}) {
    const logGroup = `/aws/lambda/${opts.functionName}`;

    let response;
    try {
        response = await makeClient().send(new FilterLogEventsCommand({
            logGroupName: logGroup,
            startTime: opts.startTimeMs,
            endTime: opts.endTimeMs,
            limit: opts.limit,
            ...(opts.errorOnly ? { filterPattern: '{ $.level = "ERROR" }' } : {}),
        }));
    } catch (err) {
        console.warn(`CloudWatch log group ${logGroup} not found or inaccessible:`, err);
        return [];
    }

    return (response.events ?? []).map((event) => {
        const msg = event.message ?? "";
        return {
            timestamp: event.timestamp ?? Date.now(),
            message: msg.trim(),
            level: detectLogLevel(msg),
            logGroup,
            logStream: event.logStreamName,
            requestId: extractRequestId(msg),
        };
    });
}

function detectLogLevel(msg: string): "INFO" | "WARN" | "ERROR" | "DEBUG" {
    const trimmed = msg.trim();
    if (trimmed.startsWith("{")) {
        try {
            const lvl = String(JSON.parse(trimmed).level ?? "").toUpperCase();
            if (lvl === "ERROR" || lvl === "WARN" || lvl === "INFO" || lvl === "DEBUG") {
                return lvl;
            }
        } catch {
            // fall through to heuristic
        }
    }

    const upper = msg.toUpperCase();
    if (upper.includes("ERROR")) return "ERROR";
    if (upper.includes("WARN")) return "WARN";
    if (upper.includes("[DEBUG]") || upper.startsWith("DEBUG")) return "DEBUG";
    return "INFO";
}

function extractRequestId(msg: string): string | undefined {
    return msg.match(/RequestId:\s*([a-f0-9-]{36})/i)?.[1];
}

async function runInsightsQuery(opts: {
    logGroupNames: string[];
    startTimeSec: number;
    endTimeSec: number;
    queryString: string;
}): Promise<Array<Record<string, string>>> {
    if (opts.logGroupNames.length === 0) return [];

    const client = makeClient();

    let queryId: string | undefined;
    try {
        const start = await client.send(new StartQueryCommand({
            logGroupNames: opts.logGroupNames,
            startTime: opts.startTimeSec,
            endTime: opts.endTimeSec,
            queryString: opts.queryString,
            limit: 10000,
        }));
        queryId = start.queryId;
    } catch (err) {
        console.warn("CloudWatch Logs Insights StartQuery failed:", err);
        return [];
    }
    if (!queryId) return [];

    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1000));

        let result;
        try {
            result = await client.send(new GetQueryResultsCommand({ queryId }));
        } catch (err) {
            console.warn("CloudWatch Logs Insights GetQueryResults failed:", err);
            return [];
        }

        const status = result.status ?? "Running";
        if (status === "Complete") {
            return (result.results ?? []).map((row) => {
                const out: Record<string, string> = {};
                for (const field of row) {
                    if (field.field) out[field.field] = field.value ?? "";
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
    handler: async (ctx, args): Promise<LogEntry[]> => {
        const authUser = await authKit.getAuthUser(ctx);
        if (!authUser) return [];

        const now = Date.now();
        const startTime = now - (args.lookbackMs ?? 60 * 60 * 1000);

        const deployments: { _id: Id<"agentDeployments">; endpointId: string }[] =
            await ctx.runQuery(internal.logsHelpers.getActiveDeploymentsInternal, {
                authId: authUser.id,
                projectId: args.projectId,
            });

        const sources: { logGroup: string; functionName: string }[] = deployments.map((d) => ({
            logGroup: `/aws/lambda/${d.endpointId}`,
            functionName: d.endpointId,
        }));
        const harnessLogGroup = getFilthyPantyLogGroup();
        if (harnessLogGroup) {
            sources.push({
                logGroup: harnessLogGroup,
                functionName: harnessLogGroup.replace(/^\/aws\/lambda\//, ""),
            });
        }
        if (sources.length === 0) return [];

        const batches = await Promise.all(
            sources.map(async (s) => {
                const entries = await fetchFromCloudWatch({
                    functionName: s.functionName,
                    startTimeMs: startTime,
                    endTimeMs: now,
                    limit: args.limit ?? 100,
                    errorOnly: args.errorOnly ?? false,
                });
                return entries.map((e) => ({ ...e, functionName: s.functionName }));
            }),
        );

        return batches.flat().sort((a, b) => b.timestamp - a.timestamp);
    },
});

export const fetchForCli = internalAction({
    args: {
        secretHash: v.string(),
        project: v.string(),
        environment: v.string(),
        lookbackMs: v.optional(v.number()),
        limit: v.optional(v.number()),
        errorOnly: v.optional(v.boolean()),
    },
    returns: v.array(logEntry),
    handler: async (ctx, args) => {
        const now = Date.now();
        const startTime = now - boundedNumber(args.lookbackMs, 60 * 60 * 1000, 60_000, 30 * 24 * 60 * 60 * 1000);
        const limit = boundedNumber(args.limit, 100, 1, 1000);
        const sources: LogSource[] | null = await ctx.runQuery(internal.logsHelpers.getCliLogSourcesBySecretHash, {
            secretHash: args.secretHash,
            project: args.project,
            environment: args.environment,
        });
        if (!sources) throw new Error("Project/environment not found");

        const allSources: LogSource[] = [...sources];
        const harnessLogGroup = getFilthyPantyLogGroup();
        if (harnessLogGroup) {
            allSources.push({
                logGroup: harnessLogGroup,
                functionName: harnessLogGroup.replace(/^\/aws\/lambda\//, ""),
            });
        }
        if (allSources.length === 0) return [];

        const batches: LogEntry[][] = await Promise.all(
            allSources.map(async (source: LogSource): Promise<LogEntry[]> => {
                const entries = await fetchFromCloudWatch({
                    functionName: source.functionName,
                    startTimeMs: startTime,
                    endTimeMs: now,
                    limit: limit,
                    errorOnly: args.errorOnly ?? false,
                });
                return entries.map((entry): LogEntry => ({ ...entry, functionName: source.functionName }));
            }),
        );

        return batches.flat().sort((a: LogEntry, b: LogEntry) => b.timestamp - a.timestamp).slice(0, limit);
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

        const logGroupNames = deployments.map((d: { endpointId: string }) => `/aws/lambda/${d.endpointId}`);
        const harnessLogGroup = getFilthyPantyLogGroup();
        if (harnessLogGroup) {
            logGroupNames.push(harnessLogGroup);
        }
        if (logGroupNames.length === 0) {
            return empty;
        }

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

function boundedNumber(value: number | undefined, fallback: number, min: number, max: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;

    return Math.min(max, Math.max(min, Math.floor(value)));
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
