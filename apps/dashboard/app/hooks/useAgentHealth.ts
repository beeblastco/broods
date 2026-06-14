"use client";

/**
 * Derives agent health status from core service reachability.
 * Uses a shared module-level cache so multiple agent nodes don't duplicate health requests.
 */
import type { Id } from "@filthy-panty/convex/_generated/dataModel";
import { useEffect, useState } from "react";

/** Possible agent health statuses for display. */
export type AgentHealthStatus = "healthy" | "deploying" | "idle" | "unhealthy";

/** Health check polling interval in ms. */
const HEALTH_CHECK_INTERVAL = 30_000;

/** Shared cache for core service health across all hook instances. */
let healthCache: { healthy: boolean | null; checkedAt: number } = { healthy: null, checkedAt: 0 };
let pendingCheck: Promise<boolean> | null = null;
let listenerCount = 0;
let pollingInterval: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

/** Browser-safe fetch timeout helper (works even when AbortSignal.timeout is unavailable). */
async function fetchHealthWithTimeout(url: string, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

    try {
        return await fetch(url, { signal: controller.signal });
    } finally {
        window.clearTimeout(timeoutId);
    }
}

/** Notify all active hook instances of a health update. */
function notifyListeners() {
    for (const listener of listeners) {
        listener();
    }
}

/** Fetch core service health, deduplicating concurrent requests. */
async function checkServiceHealth(): Promise<boolean> {
    const now = Date.now();
    if (now - healthCache.checkedAt < HEALTH_CHECK_INTERVAL && healthCache.healthy !== null) {
        return healthCache.healthy;
    }

    if (pendingCheck) return pendingCheck;

    const coreUrl = (process.env.NEXT_PUBLIC_FILTHY_PANTY_BASE_URL || "https://app.beeblast.co").replace(/\/+$/, "");

    pendingCheck = fetchHealthWithTimeout(coreUrl, 5000)
        .then((res) => {
            healthCache = { healthy: res.ok, checkedAt: Date.now() };
            pendingCheck = null;
            notifyListeners();

            return res.ok;
        })
        .catch(() => {
            healthCache = { healthy: false, checkedAt: Date.now() };
            pendingCheck = null;
            notifyListeners();

            return false;
        });

    return pendingCheck;
}

/** Start shared polling when the first hook mounts. */
function subscribe(listener: () => void) {
    listeners.add(listener);
    listenerCount++;
    if (listenerCount === 1) {
        void checkServiceHealth();
        pollingInterval = setInterval(checkServiceHealth, HEALTH_CHECK_INTERVAL);
    }

    return () => {
        listeners.delete(listener);
        listenerCount--;
        if (listenerCount === 0 && pollingInterval) {
            clearInterval(pollingInterval);
            pollingInterval = null;
        }
    };
}

/**
 * Returns whether the core service is reachable.
 * @returns true if healthy, false if unhealthy, null if not yet checked
 */
export function useCoreServiceHealth(): boolean | null {
    const [, forceUpdate] = useState(0);

    useEffect(() => {
        const unsubscribe = subscribe(() => forceUpdate((n) => n + 1));

        return unsubscribe;
    }, []);

    return healthCache.healthy;
}

/**
 * Returns the health status of an agent based on core service reachability.
 * @param agentConfigId agent config to check health for
 * @returns AgentHealthStatus: healthy, deploying, idle, or unhealthy
 */
export function useAgentHealth(agentConfigId: Id<"agentConfigs"> | undefined): AgentHealthStatus {
    const [, forceUpdate] = useState(0);

    useEffect(() => {
        if (!agentConfigId) return;

        const unsubscribe = subscribe(() => forceUpdate((n) => n + 1));

        return unsubscribe;
    }, [agentConfigId]);

    if (!agentConfigId) {
        return "idle";
    }

    if (healthCache.healthy === null) {
        return "deploying";
    }

    return healthCache.healthy ? "healthy" : "unhealthy";
}
