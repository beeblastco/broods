"use client";

/**
 * Mounts the browser performance beacon: Core Web Vitals, long tasks, and
 * route-transition duration. App-specific marks (canvas render, side-panel
 * open, optimistic-save latency) call `reportPerf` from where they happen.
 */
import { reportPerf, routePattern } from "@/app/lib/perfReport";
import { useReportWebVitals } from "next/web-vitals";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

// Below this a "long task" is just scheduling noise, and the observer fires
// often enough during a drag to flood the buffer.
const LONG_TASK_FLOOR_MS = 100;

/** Derived from the hook rather than Next's internal compiled path. */
type WebVitalsMetric = Parameters<Parameters<typeof useReportWebVitals>[0]>[0];

// Hoisted so the callback identity never changes — a new function would make
// useReportWebVitals replay every metric collected so far.
function reportWebVital(metric: WebVitalsMetric) {
  reportPerf(`web-vital.${metric.name}`, metric.value, {
    unit: metric.name === "CLS" ? "score" : "ms",
    attributes: {
      rating: metric.rating,
      navigation_type: metric.navigationType,
    },
  });
}

export function PerfReporter() {
  useReportWebVitals(reportWebVital);
  const pathname = usePathname();
  const transitionFrom = useRef<{ path: string; at: number } | null>(null);

  useEffect(() => {
    const previous = transitionFrom.current;
    transitionFrom.current = { path: pathname, at: performance.now() };
    if (!previous || previous.path === pathname) return;

    reportPerf("route.transition", performance.now() - previous.at, {
      attributes: { from: routePattern(previous.path) },
    });
  }, [pathname]);

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
      // Not every browser ships the longtask entry type; treat it as optional.
      observer.observe({ type: "longtask", buffered: true });
    } catch {
      return;
    }

    return () => observer.disconnect();
  }, []);

  return null;
}
