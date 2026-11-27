"use client";

import { StatusDot, type StatusTone } from "@/app/components/StatusDot";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceLine,
  TraceTitle,
} from "@/app/components/ui/trace";
import type { DockToolStep, DockTracePart } from "@/app/lib/dockTrace";
import { formatDuration } from "@/app/lib/formatTime";
import { useState } from "react";

const MAX_PAYLOAD_CHARS = 4096;

const STEP_LABEL: Record<"ended" | "error" | "ok" | "running", string> = {
  ended: "Stopped",
  error: "Failed",
  ok: "Done",
  running: "Running",
};

/** An answer's reasoning and tool steps in one row, open while it works and folded after. */
export function CopilotTrace({
  answeredAt,
  pending,
  startedAt,
  trace,
}: {
  answeredAt?: number;
  pending: boolean;
  startedAt?: number;
  trace: readonly DockTracePart[];
}): React.JSX.Element | null {
  const [toggled, setToggled] = useState<boolean | null>(null);
  if (trace.length === 0) return null;

  const tools = trace.filter((part) => part.kind === "tool").length;
  const seconds =
    answeredAt !== undefined && startedAt !== undefined
      ? `${Math.max(1, Math.round((answeredAt - startedAt) / 1000))}s`
      : null;
  const status = seconds
    ? `${tools > 0 ? "Worked" : "Thought"} for ${seconds}`
    : tools > 0
      ? "Working..."
      : "Thinking...";
  const summary =
    tools > 0
      ? `${status} · ${tools} ${tools === 1 ? "tool" : "tools"}`
      : status;

  return (
    <div data-dock-trace className="mb-2">
      <TraceCollapsible
        open={toggled ?? answeredAt === undefined}
        onOpenChange={(open) => setToggled(open)}
      >
        <TraceCollapsibleTrigger>
          <TraceLine size="sm">
            <TraceTitle>{summary}</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent size="sm">
          <Trace>
            {trace.map((part) =>
              part.kind === "reasoning" ? (
                <p
                  key={part.id}
                  data-dock-reasoning
                  className="border-l-2 border-border pl-2 whitespace-pre-wrap text-muted-foreground"
                >
                  {part.text}
                </p>
              ) : (
                <ToolStep key={part.id} pending={pending} step={part} />
              ),
            )}
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </div>
  );
}

function Payload({
  label,
  value,
}: {
  label: string;
  value: unknown;
}): React.JSX.Element {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const cut = text.length > MAX_PAYLOAD_CHARS;

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs">{label}</span>
      <pre className="max-h-60 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap wrap-break-word text-foreground">
        {cut ? text.slice(0, MAX_PAYLOAD_CHARS) : text}
      </pre>
      {cut && (
        <span className="text-xs">
          First 4 KB of {Math.ceil(text.length / 1024)} KB shown.
        </span>
      )}
    </div>
  );
}

// A step the stream never closed (a question, an approval, a dropped stream) stops with its answer.
function ToolStep({
  pending,
  step,
}: {
  pending: boolean;
  step: DockToolStep;
}): React.JSX.Element {
  const tone: Extract<StatusTone, "ended" | "error" | "ok" | "running"> =
    step.error
      ? "error"
      : step.endedAt !== undefined
        ? "ok"
        : pending
          ? "running"
          : "ended";

  return (
    <TraceCollapsible data-dock-step={tone}>
      <TraceCollapsibleTrigger>
        <TraceLine size="sm" status={tone === "error" ? "error" : undefined}>
          <StatusDot tone={tone} label={STEP_LABEL[tone]} />
          <TraceTitle>{step.title}</TraceTitle>
          {step.endedAt !== undefined && (
            <TraceDescription>
              {formatDuration(step.endedAt - step.startedAt)}
            </TraceDescription>
          )}
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent size="sm">
        <div className="flex flex-col gap-2">
          {step.input !== undefined && (
            <Payload label="Input" value={step.input} />
          )}
          {step.error ? (
            <Payload label="Error" value={step.error} />
          ) : (
            step.output !== undefined && (
              <Payload label="Output" value={step.output} />
            )
          )}
        </div>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}
