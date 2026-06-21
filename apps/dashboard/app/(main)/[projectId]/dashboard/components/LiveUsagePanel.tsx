"use client";

/** Live usage card: real-time tokens and sandbox CPU for the most recent task, accumulated straight off the trace stream and animated as steps arrive. */
import { cn } from "@/app/lib/utils";
import {
  useObservabilityStream,
  type ObservabilitySpanRow,
} from "@/app/hooks/useObservabilityStream";
import { Activity, Cpu } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

interface Props {
  projectSlug: string | undefined;
  environmentSlug: string | undefined;
  apiKey: string | undefined;
}

/** Read a numeric span attribute, defaulting to 0. */
function numAttr(span: ObservabilitySpanRow | undefined, key: string): number {
  const value = span?.attributes?.[key];

  return typeof value === "number" ? value : 0;
}

/** Smoothly animate a number toward its latest value with a cubic ease-out. */
function useCountUp(value: number): number {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);

  useEffect(() => {
    const from = fromRef.current;
    const to = value;
    if (from === to) return;
    let raf = 0;
    let start: number | null = null;
    const duration = 450;
    const tick = (now: number) => {
      if (start === null) start = now;
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(Math.round(from + (to - from) * eased));
      if (progress < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        fromRef.current = to;
      }
    };
    raf = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(raf);
  }, [value]);

  return display;
}

/** One animated count-up stat tile. */
function StatTile({ label, value, accent }: { label: string; value: number; accent: string }) {
  const shown = useCountUp(value);

  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-border bg-card px-3 py-2">
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={cn("font-mono text-lg tabular-nums", accent)}>{shown.toLocaleString()}</span>
    </div>
  );
}

/** Format microseconds of CPU as a compact ms/s reading. */
function formatCpu(usec: number): string {
  const ms = usec / 1000;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;

  return `${Math.round(ms)}ms`;
}

export function LiveUsagePanel({ projectSlug, environmentSlug, apiKey }: Props) {
  const { entries, status } = useObservabilityStream({
    stream: "traces",
    projectSlug: projectSlug,
    environmentSlug: environmentSlug,
    apiKey: apiKey,
    backfill: 20,
  });

  // The most recent task and its model steps, ordered as they ran.
  const { task, steps } = useMemo(() => {
    const tasks = entries.filter((entry) => entry.kind === "task");
    const latest = tasks.sort((a, b) => b.startTimeMs - a.startTimeMs)[0];
    const taskSteps = latest
      ? entries
          .filter((entry) => entry.kind === "model.step" && entry.traceId === latest.traceId)
          .sort((a, b) => a.startTimeMs - b.startTimeMs)
      : [];

    return { task: latest, steps: taskSteps };
  }, [entries]);

  // Accumulate from steps while running; fall back to the root totals once the
  // task has finished (e.g. a backfilled task with no step spans).
  const stepInput = steps.reduce((sum, step) => sum + numAttr(step, "model.input_tokens"), 0);
  const stepOutput = steps.reduce((sum, step) => sum + numAttr(step, "model.output_tokens"), 0);
  const stepReasoning = steps.reduce((sum, step) => sum + numAttr(step, "model.reasoning_tokens"), 0);
  const stepCached = steps.reduce((sum, step) => sum + numAttr(step, "model.cached_input_tokens"), 0);

  const input = stepInput || numAttr(task, "usage.input_tokens");
  const output = stepOutput || numAttr(task, "usage.output_tokens");
  const reasoning = stepReasoning || numAttr(task, "usage.reasoning_tokens");
  const cached = stepCached || numAttr(task, "usage.cached_input_tokens");
  const total = input + output;

  const taskRunning = task?.status === "running";
  const cpuByProvider = task
    ? Object.entries(task.attributes ?? {})
        .filter(([key]) => key.startsWith("sandbox.cpu_usec."))
        .map(([key, value]) => ({ type: key.replace("sandbox.cpu_usec.", ""), usec: Number(value) }))
        .filter((row) => row.usec > 0)
    : [];

  // Per-step output tokens drive the signature stream bars; scale to the busiest step.
  const stepMax = Math.max(1, ...steps.map((step) => numAttr(step, "model.output_tokens")));
  const totalShown = useCountUp(total);

  const hasData = Boolean(task);

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card/40 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Activity className={cn("size-4", taskRunning ? "text-sky-400" : "text-muted-foreground")} />
          <span className="text-sm font-medium text-foreground">Live usage</span>
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
              taskRunning
                ? "bg-sky-500/15 text-sky-300"
                : status === "live"
                  ? "bg-emerald-500/10 text-emerald-300/80"
                  : "bg-muted text-muted-foreground",
            )}
          >
            {taskRunning && <span className="size-1.5 animate-pulse rounded-full bg-sky-400" />}
            {taskRunning ? "Streaming" : status === "live" ? "Idle" : status}
          </span>
        </div>
        {task && (
          <span className="truncate font-mono text-[11px] text-muted-foreground/70" title={task.agentId ?? task.traceId}>
            {task.agentId ?? task.traceId}
          </span>
        )}
      </div>

      {!hasData ? (
        <p className="py-6 text-center text-xs text-muted-foreground/60">
          Waiting for a task to run — usage streams here as model steps complete.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
            <div className="flex flex-col">
              <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Total tokens</span>
              <span className="font-mono text-3xl tabular-nums text-foreground">{totalShown.toLocaleString()}</span>
            </div>
            <div className="grid flex-1 grid-cols-2 gap-2 sm:grid-cols-4">
              <StatTile label="Input" value={input} accent="text-sky-300" />
              <StatTile label="Output" value={output} accent="text-violet-300" />
              <StatTile label="Reasoning" value={reasoning} accent="text-amber-300" />
              <StatTile label="Cached" value={cached} accent="text-emerald-300" />
            </div>
          </div>

          {/* Signature: a streaming strip of per-step output-token bars that grow
              in as each model step finishes. */}
          <div>
            <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
              <span>Output per step</span>
              <span>{steps.length} step{steps.length === 1 ? "" : "s"}</span>
            </div>
            <div className="flex h-16 items-end gap-1 overflow-hidden rounded-lg border border-border bg-background/40 px-2 py-1.5">
              {steps.length === 0 ? (
                <span className="m-auto text-[11px] text-muted-foreground/50">No steps yet…</span>
              ) : (
                steps.map((step, index) => {
                  const out = numAttr(step, "model.output_tokens");
                  const last = index === steps.length - 1;
                  const running = step.status === "running";

                  return (
                    <div
                      key={`${step.spanId}`}
                      className={cn(
                        "min-w-[6px] flex-1 rounded-sm transition-[height] duration-500 ease-out",
                        running ? "animate-pulse bg-sky-500/50" : last ? "bg-violet-400/80" : "bg-violet-500/40",
                      )}
                      style={{ height: `${Math.max(6, (out / stepMax) * 100)}%` }}
                      title={`Step ${index + 1} · ${out.toLocaleString()} output tokens`}
                    />
                  );
                })
              )}
            </div>
          </div>

          {cpuByProvider.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/50 pt-2 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1.5 font-medium uppercase tracking-wide">
                <Cpu className="size-3" /> Sandbox CPU
              </span>
              {cpuByProvider.map((row) => (
                <span key={row.type} className="font-mono">
                  {row.type} <span className="text-foreground/80">{formatCpu(row.usec)}</span>
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
