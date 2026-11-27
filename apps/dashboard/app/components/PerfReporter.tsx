"use client";

import { reportPerf, routePattern } from "@/app/lib/perfReport";
import { useReportWebVitals } from "next/web-vitals";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

// Long tasks start at 50 ms, but below 100 they are noise that floods the buffer on a drag.
const LONG_TASK_FLOOR_MS = 100;
const LONG_FRAME = "long-animation-frame";
// INP reports on page hide, so the frames its interaction ran in must still be here.
const RECENT_FRAMES = 32;

type WebVitalsMetric = Parameters<Parameters<typeof useReportWebVitals>[0]>[0];

let recentFrames: PerformanceLongAnimationFrameTiming[] = [];

// Module scope: a new callback identity makes useReportWebVitals replay every metric.
function reportWebVital(metric: WebVitalsMetric): void {
  reportPerf(`web-vital.${metric.name}`, metric.value, {
    unit: metric.name === "CLS" ? "score" : "ms",
    attributes: {
      rating: metric.rating,
      navigation_type: metric.navigationType,
      ...(metric.name === "INP"
        ? scriptAttributes(framesDuring(metric.entries))
        : {}),
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

    const observers = [
      observe("longtask", (list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration >= LONG_TASK_FLOOR_MS)
            reportPerf("long-task", entry.duration);
        }
      }),
      // Long animation frames name the script behind a slow INP; only Chromium has them.
      observe(LONG_FRAME, (list) => {
        recentFrames = [
          ...recentFrames,
          ...list.getEntriesByType(LONG_FRAME),
        ].slice(-RECENT_FRAMES);
      }),
    ];

    return () => {
      for (const observer of observers) observer?.disconnect();
    };
  }, []);

  return null;
}

function framesDuring(
  entries: PerformanceEntry[],
): PerformanceLongAnimationFrameTiming[] {
  return recentFrames.filter((frame) =>
    entries.some(
      (entry) =>
        frame.startTime < entry.startTime + entry.duration &&
        entry.startTime < frame.startTime + frame.duration,
    ),
  );
}

// An element invoker names its node by id or src, which may carry tenant data: keep tag and event.
function invokerLabel(invoker: string): string {
  if (URL.canParse(invoker)) return scriptSource(invoker);

  return invoker.replace(/[#[].*(\.on\w+)$/, "$1");
}

// Not every browser ships every entry type; an unsupported one observes nothing.
function observe(
  type: string,
  onEntries: (list: PerformanceObserverEntryList) => void,
): PerformanceObserver | null {
  if (!PerformanceObserver.supportedEntryTypes.includes(type)) return null;
  const observer = new PerformanceObserver(onEntries);
  observer.observe({ type: type, buffered: true });

  return observer;
}

function scriptAttributes(
  frames: PerformanceLongAnimationFrameTiming[],
): Record<string, string | number> {
  const top = frames
    .flatMap((frame) => frame.scripts)
    .reduce<PerformanceScriptTiming | null>(
      (longest, script) =>
        !longest || script.duration > longest.duration ? script : longest,
      null,
    );
  if (!top) return {};

  return {
    script_source: scriptSource(top.sourceURL),
    script_invoker: invokerLabel(top.invoker),
    forced_style_layout_ms: Math.round(top.forcedStyleAndLayoutDuration),
  };
}

// An inline script's URL is the page's, which holds tenant ids.
function scriptSource(url: string): string {
  if (!URL.canParse(url)) return url;
  const { origin, pathname } = new URL(url);
  if (origin !== window.location.origin) return `${origin}${pathname}`;

  return pathname.startsWith("/_next/") ? pathname : routePattern(pathname);
}
