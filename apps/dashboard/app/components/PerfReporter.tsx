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

// lib.dom ships no Long Animation Frames types yet.
interface ScriptTiming {
  duration: number;
  forcedStyleAndLayoutDuration: number;
  invoker: string;
  sourceURL: string;
}

interface LongAnimationFrame extends PerformanceEntry {
  scripts: ScriptTiming[];
}

let recentFrames: LongAnimationFrame[] = [];

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

    let observer: PerformanceObserver;
    try {
      // Long animation frames name the script behind a slow frame; only Chromium has them.
      const framed =
        PerformanceObserver.supportedEntryTypes.includes(LONG_FRAME);
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const frame = framed ? (entry as LongAnimationFrame) : null;
          if (frame)
            recentFrames = [...recentFrames, frame].slice(-RECENT_FRAMES);
          if (entry.duration < LONG_TASK_FLOOR_MS) continue;
          reportPerf("long-task", entry.duration, {
            attributes: frame ? scriptAttributes([frame]) : {},
          });
        }
      });
      // Not every browser ships the longtask entry type.
      observer.observe({
        type: framed ? LONG_FRAME : "longtask",
        buffered: true,
      });
    } catch {
      return;
    }

    return () => observer.disconnect();
  }, []);

  return null;
}

function framesDuring(entries: PerformanceEntry[]): LongAnimationFrame[] {
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

function scriptAttributes(
  frames: LongAnimationFrame[],
): Record<string, string | number> {
  const top = frames
    .flatMap((frame) => frame.scripts)
    .reduce<ScriptTiming | null>(
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
