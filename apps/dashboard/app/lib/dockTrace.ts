import {
  ACCOUNT_NAV_ITEMS,
  activeNavItem,
  NAV_ITEMS,
} from "@/app/lib/navigation";
import type { TextStreamPart, ToolSet } from "ai";
import { z } from "zod";

export const NAVIGATE_TOOL = "dock__navigate";

const DOCK_PREFIX = "dock__";
const PROPOSE_NAME = "propose_changes";

// Same-origin check: a relative path resolves against this and must stay on it.
const ORIGIN = "https://dashboard.invalid";

const apiSchema = z.object({ method: z.string(), path: z.string() });
const navigateSchema = z.object({ path: z.string() });
// An MCP CallToolResult: its text parts are what the agent read.
const mcpResultSchema = z.object({
  content: z.array(z.object({ text: z.string().optional(), type: z.string() })),
});

export type DockTracePart =
  | { id: string; kind: "reasoning"; text: string }
  | {
      endedAt?: number;
      error?: string;
      id: string;
      input?: unknown;
      kind: "tool";
      name: string;
      output?: unknown;
      startedAt: number;
      /** What the step reads as: `GET /path`, `Opened Scheduler`, or the bare tool name. */
      title: string;
    };

export type DockToolStep = Extract<DockTracePart, { kind: "tool" }>;

/** Folds one stream part into the answer's trace; parts it does not draw return the same array. */
export function traceStep(
  trace: readonly DockTracePart[],
  part: TextStreamPart<ToolSet>,
  now: number,
): readonly DockTracePart[] {
  const last = trace.at(-1);
  switch (part.type) {
    case "reasoning-start":
      return [...trace, { id: part.id, kind: "reasoning", text: "" }];
    case "reasoning-delta":
      return last?.kind === "reasoning"
        ? [...trace.slice(0, -1), { ...last, text: last.text + part.text }]
        : [...trace, { id: part.id, kind: "reasoning", text: part.text }];
    case "reasoning-end":
      return last?.kind === "reasoning" && !last.text.trim()
        ? trace.slice(0, -1)
        : trace;
    case "tool-input-start":
      return withTool(trace, part.id, part.toolName, now, (step) => step);
    case "tool-call": {
      const refused =
        part.toolName === NAVIGATE_TOOL && !navigatePath(part.input)
          ? "Not a dashboard path."
          : part.invalid
            ? errorText(part.error)
            : undefined;

      return withTool(trace, part.toolCallId, part.toolName, now, (step) => ({
        ...step,
        input: part.input,
        title: toolTitle(part.toolName, part.input),
        ...(refused ? { endedAt: now, error: refused } : {}),
      }));
    }
    case "tool-result":
      return withTool(trace, part.toolCallId, part.toolName, now, (step) => ({
        ...step,
        output: toolOutput(part.output),
        ...(part.preliminary ? {} : { endedAt: now }),
      }));
    case "tool-error":
      return withTool(trace, part.toolCallId, part.toolName, now, (step) => ({
        ...step,
        endedAt: now,
        error: errorText(part.error),
      }));
    default:
      return trace;
  }
}

/** A dashboard path the agent may open, or null for anything that could leave the dashboard. */
export function navigatePath(input: unknown): string | null {
  const parsed = navigateSchema.safeParse(input);
  if (!parsed.success) return null;
  const { path } = parsed.data;
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  const url = new URL(path, ORIGIN);

  return url.origin === ORIGIN
    ? `${url.pathname}${url.search}${url.hash}`
    : null;
}

/** The section a dashboard path opens, as the sidebar names it, with its tab when it has one. */
export function pageLabel(path: string): string {
  const url = new URL(path, ORIGIN);
  const account = ACCOUNT_NAV_ITEMS.find((item) =>
    url.pathname.startsWith(item.segment),
  );
  const projectId = url.pathname.split("/")[1] ?? "";
  const item =
    account ?? activeNavItem(NAV_ITEMS, url.pathname, `/${projectId}`);
  const tab = item.tabs.find(
    (entry) => entry.id === url.searchParams.get("tab"),
  );

  return tab ? `${item.label} / ${tab.label}` : item.label;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;

  return typeof error === "string" ? error : JSON.stringify(error);
}

function toolOutput(output: unknown): unknown {
  const parsed = mcpResultSchema.safeParse(output);
  if (!parsed.success) return output;

  return parsed.data.content
    .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
    .join("\n");
}

function toolTitle(toolName: string, input: unknown): string {
  const name = toolName.startsWith(DOCK_PREFIX)
    ? toolName.slice(DOCK_PREFIX.length)
    : toolName;
  if (name === PROPOSE_NAME) return "Proposed changes";
  if (toolName === NAVIGATE_TOOL) {
    const path = navigatePath(input);

    return path ? `Opened ${pageLabel(path)}` : name;
  }
  const api = name === "broods_api" ? apiSchema.safeParse(input) : null;

  return api?.success
    ? `${api.data.method.toUpperCase()} ${api.data.path}`
    : name;
}

// A result can arrive with no start (a provider-run tool): it opens and settles at once.
function withTool(
  trace: readonly DockTracePart[],
  id: string,
  name: string,
  now: number,
  change: (step: DockToolStep) => DockToolStep,
): readonly DockTracePart[] {
  const index = trace.findIndex(
    (part) => part.kind === "tool" && part.id === id,
  );
  const found = trace[index];
  if (found?.kind === "tool") {
    return trace.map((part, at) => (at === index ? change(found) : part));
  }

  return [
    ...trace,
    change({
      id: id,
      kind: "tool",
      name: name,
      startedAt: now,
      title: toolTitle(name, undefined),
    }),
  ];
}
