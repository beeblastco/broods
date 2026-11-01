"use client";

import { reportPerf, routePattern } from "@/app/lib/perfReport";
import { useReportWebVitals } from "next/web-vitals";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

// Long tasks start at 50 ms, but below 100 they are noise that floods the buffer on a drag.
const LONG_TASK_FLOOR_MS = 100;

type WebVitalsMetric = Parameters<Parameters<typeof useReportWebVitals>[0]>[0];

// Module scope: a new callback identity makes useReportWebVitals replay every metric.
function reportWebVital(metric: WebVitalsMetric): void {
  reportPerf(`web-vital.${metric.name}`, metric.value, {
    unit: metric.name === "CLS" ? "score" : "ms",
    attributes: {
      rating: metric.rating,
      navigation_type: metric.navigationType,
    },
  });
}

export function PerfReporter(): null {
  useReportWebVitals(reportWebVital);
  const pathname = usePathname();
  const transitionFrom = useRef<{ path: string; at: number } | null>(null);

  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- perf beacon, route commit time
  useEffect(() => {
    const previous = transitionFrom.current;
    transitionFrom.current = { path: pathname, at: performance.now() };
    if (!previous || previous.path === pathname) return;

    reportPerf("route.transition", performance.now() - previous.at, {
      attributes: { from: routePattern(previous.path) },
    });
  }, [pathname]);

  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- PerformanceObserver subscription
  useEffect(() => {
    if (typeof PerformanceObserver === "undefined") return;

    let observer: PerformanceObserver;
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration < LONG_TASK_FLOOR_MS) continue;
          reportPerf("long-task", entry.duration);
        }
      });
      // Not every browser ships the longtask entry type.
      observer.observe({ type: "longtask", buffered: true });
    } catch {
      return;
    }

    return () => observer.disconnect();
  }, []);

  return null;
}
