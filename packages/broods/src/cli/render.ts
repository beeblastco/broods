/**
 * Pretty terminal rendering for a streamed agent run (`broods run`).
 * Switches over the full Vercel AI SDK `TextStreamPart` union: reasoning, text,
 * streamed tool input, tool calls/results/errors, approvals, sources, files, and
 * lifecycle/usage parts. Section boundaries come from the SDK's own
 * `*-start`/`*-end` parts rather than tracked flags.
 */

import type { TextStreamPart, ToolSet } from "ai";

const RESET = "\x1b[0m";
const DIM = "\x1b[90m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";
const YELLOW = "\x1b[33m";
const GREY = "\x1b[37m";
const RED = "\x1b[31m";

/**
 * Per-run state. We only need to remember which tool calls already showed their
 * input live (via `tool-input-*` deltas) so the authoritative `tool-call` part
 * does not print the arguments a second time.
 */
export interface RenderState {
  streamedToolInputs: Set<string>;
}

export function createRenderState(): RenderState {
  return { streamedToolInputs: new Set() };
}

function useColor(): boolean {
  if (Object.hasOwn(process.env, "NO_COLOR")) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;

  return Boolean(process.stdout.isTTY) && process.env.TERM !== "dumb";
}

function paint(value: string, style: string): string {
  return useColor() ? `${style}${value}${RESET}` : value;
}

function write(value: string, style?: string): void {
  process.stdout.write(style ? paint(value, style) : value);
}

/** Truncate noisy tool input/output so a run stays scannable. */
function preview(value: unknown, max = 500): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return "";

  return text.length > max
    ? `${text.slice(0, max)}… [${text.length - max} more chars]`
    : text;
}

/** Compact `12 in / 34 out` usage summary; empty when the provider omits counts. */
function formatUsage(usage: {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}): string {
  const parts: string[] = [];
  if (typeof usage.inputTokens === "number")
    parts.push(`${usage.inputTokens} in`);
  if (typeof usage.outputTokens === "number")
    parts.push(`${usage.outputTokens} out`);
  if (parts.length === 0 && typeof usage.totalTokens === "number")
    parts.push(`${usage.totalTokens} tokens`);

  return parts.join(" / ");
}

/**
 * Render a single stream part to stdout. Every `TextStreamPart` variant is
 * handled; purely structural parts (`start`, `start-step`, `finish-step`, `raw`)
 * are intentionally silent so the transcript stays focused on visible output.
 */
export function renderStreamPart(
  part: TextStreamPart<ToolSet>,
  state: RenderState,
): void {
  switch (part.type) {
    case "reasoning-start":
      write("\n💭 thinking\n", DIM);
      break;
    case "reasoning-delta":
      write(part.text, DIM);
      break;
    case "reasoning-end":
      write("\n");
      break;

    case "text-start":
      write("\n");
      break;
    case "text-delta":
      write(part.text, GREEN);
      break;
    case "text-end":
      write("\n");
      break;

    case "tool-input-start":
      state.streamedToolInputs.add(part.id);
      write(`\n🔧 ${part.toolName}(`, CYAN);
      break;
    case "tool-input-delta":
      write(part.delta, DIM);
      break;
    case "tool-input-end":
      write(")\n", CYAN);
      break;
    case "tool-call":
      // Already shown live via tool-input-* deltas; only print here when the
      // provider emitted the call without streaming its input.
      if (!state.streamedToolInputs.has(part.toolCallId)) {
        write(`\n🔧 ${part.toolName}(${preview(part.input)})\n`, CYAN);
      }
      break;
    case "tool-result":
      write(`↳ ${part.toolName} → ${preview(part.output)}\n`, MAGENTA);
      break;
    case "tool-error":
      write(`↳ ${part.toolName} error: ${preview(part.error)}\n`, RED);
      break;
    case "tool-output-denied":
      write(`↳ ${part.toolName} output denied\n`, YELLOW);
      break;
    case "tool-approval-request":
      write(`⏸ approval required: ${part.toolCall.toolName}\n`, YELLOW);
      break;

    case "source":
      write(
        `🔗 source: ${part.sourceType === "url" ? part.url : part.title}\n`,
        DIM,
      );
      break;
    case "file":
      write(`📎 file: ${part.file.mediaType}\n`, DIM);
      break;

    case "finish":
      write(
        `\n[finished: ${part.finishReason}${formatUsage(part.totalUsage) ? ` · ${formatUsage(part.totalUsage)}` : ""}]\n`,
        GREY,
      );
      break;
    case "abort":
      write(`\n[aborted${part.reason ? `: ${part.reason}` : ""}]\n`, RED);
      break;
    case "error":
      // Defensive: the client throws on error parts before they reach here.
      write(`\n[error: ${preview(part.error)}]\n`, RED);
      break;

    default:
      // start, start-step, finish-step, raw — structural, no output.
      break;
  }
}
