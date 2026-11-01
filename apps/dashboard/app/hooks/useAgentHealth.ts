"use client";

import type { Id } from "@broods/convex/_generated/dataModel";
import { useSyncExternalStore } from "react";

export type AgentHealthStatus = "healthy" | "deploying" | "idle" | "unhealthy";

const HEALTH_CHECK_INTERVAL = 30_000;

let healthCache: { healthy: boolean | null; checkedAt: number } = {
  healthy: null,
  checkedAt: 0,
};
let pendingCheck: Promise<boolean> | null = null;
let listenerCount = 0;
let pollingInterval: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

export function useAgentHealth(
  agentConfigId: Id<"agentConfigs"> | undefined,
): AgentHealthStatus {
  const healthy = useSyncExternalStore(
    agentConfigId ? subscribe : subscribeNone,
    () => healthCache.healthy,
    () => null,
  );

  if (!agentConfigId) {
    return "idle";
  }

  if (healthy === null) {
    return "deploying";
  }

  return healthy ? "healthy" : "unhealthy";
}

async function checkServiceHealth(): Promise<boolean> {
  const now = Date.now();
  if (
    now - healthCache.checkedAt < HEALTH_CHECK_INTERVAL &&
    healthCache.healthy !== null
  ) {
    return healthCache.healthy;
  }

  if (pendingCheck) return pendingCheck;

  const coreUrl = (
    process.env.NEXT_PUBLIC_BROODS_BASE_URL || "https://gateway.broods.app"
  ).replace(/\/+$/, "");

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

// Not AbortSignal.timeout, which older browsers lack.
async function fetchHealthWithTimeout(
  url: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function notifyListeners(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribeNone(): () => void {
  return () => {};
}

function subscribe(listener: () => void): () => void {
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
