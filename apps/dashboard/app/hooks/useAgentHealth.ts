"use client";

/**
 * Derives agent health status from deployment state and gateway reachability.
 * Uses a shared module-level cache so multiple agent nodes don't duplicate health requests.
 */
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import { useEffect, useState } from "react";

/** Possible agent health statuses for display. */
export type AgentHealthStatus = "healthy" | "deploying" | "idle" | "unhealthy";

/** Health check polling interval in ms. */
const HEALTH_CHECK_INTERVAL = 30_000;

/** Shared cache for gateway health across all hook instances. */
let healthCache: { healthy: boolean | null; checkedAt: number } = { healthy: null, checkedAt: 0 };
let pendingCheck: Promise<boolean> | null = null;
let listenerCount = 0;
let pollingInterval: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

/** Notify all active hook instances of a health update. */
function notifyListeners() {
    for (const listener of listeners) {
        listener();
    }
}

/** Fetch gateway health, deduplicating concurrent requests. */
async function checkGatewayHealth(): Promise<boolean> {
    const now = Date.now();
    if (now - healthCache.checkedAt < HEALTH_CHECK_INTERVAL && healthCache.healthy !== null) {
        return healthCache.healthy;
    }

    if (pendingCheck) return pendingCheck;

    pendingCheck = fetch("/api/agents/health", { signal: AbortSignal.timeout(5000) })
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
        checkGatewayHealth();
        pollingInterval = setInterval(checkGatewayHealth, HEALTH_CHECK_INTERVAL);
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
 * Returns whether the agent gateway server is reachable.
 * @returns true if healthy, false if unhealthy, null if not yet checked
 */
export function useGatewayHealth(): boolean | null {
    const [, forceUpdate] = useState(0);

    useEffect(() => {
        const unsubscribe = subscribe(() => forceUpdate((n) => n + 1));

        return unsubscribe;
    }, []);

    return healthCache.healthy;
}

/**
 * Returns the health status of an agent based on its deployment and gateway reachability.
 * @param agentConfigId agent config to check health for
 * @returns AgentHealthStatus: healthy, deploying, idle, or unhealthy
 */
export function useAgentHealth(agentConfigId: Id<"agentConfigs"> | undefined): AgentHealthStatus {
    const deployments = useQuery(
        api.agentDeployments.list,
        agentConfigId ? { agentConfigId: agentConfigId } : "skip",
    );
    const activeDeployment = deployments?.find((d) => d.status === "active");

    const [, forceUpdate] = useState(0);

    useEffect(() => {
        if (!activeDeployment) return;

        const unsubscribe = subscribe(() => forceUpdate((n) => n + 1));

        return unsubscribe;
    }, [activeDeployment]);

    if (!activeDeployment) {
        return "idle";
    }

    if (healthCache.healthy === null) {
        return "deploying";
    }

    return healthCache.healthy ? "healthy" : "unhealthy";
}
