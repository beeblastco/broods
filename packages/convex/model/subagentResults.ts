import { v, type Infer, type VLiteral } from "convex/values";
import type { Doc } from "../_generated/dataModel";

const DEDUPE_KEY_PREFIX = "subagent:";
const ASYNC_TOOL_DEDUPE_KEY_PREFIX = "async-tool:";

// pending: the live run still owes the write. detached: it gave up, the recovery sweep
// delivers it. stored: the conversation holds it (or the model read it), never resent.
export const handbackValidator = v.union(
  v.literal("pending"),
  v.literal("detached"),
  v.literal("stored"),
);
export type Handback = Infer<typeof handbackValidator>;
export const SWEPT_HANDBACKS = ["detached", "pending"] as const;
export type SweptHandback = (typeof SWEPT_HANDBACKS)[number];
export const sweptHandbackValidator = v.union(
  ...SWEPT_HANDBACKS.map((handback): VLiteral<SweptHandback> =>
    v.literal(handback),
  ),
);
export const handbackMoveValidator = v.union(
  v.literal("detached"),
  v.literal("stored"),
);
export type HandbackMove = Infer<typeof handbackMoveValidator>;
type HandbackStatus = "completed" | "failed";
export type HandbackKey =
  | { kind: "subagent"; eventId: string; status: HandbackStatus }
  | { kind: "async-tool"; resultId: string; status: HandbackStatus };

export function asyncToolResultDedupeKey(
  resultId: string,
  status: HandbackStatus,
): string {
  return `${ASYNC_TOOL_DEDUPE_KEY_PREFIX}${resultId}:${status}`;
}

export function subagentResultDedupeKey(
  eventId: string,
  status: Doc<"runtimeAsyncAgentResults">["status"] | "running",
): string {
  return `${DEDUPE_KEY_PREFIX}${eventId}:${status}`;
}

export function parseHandbackDedupeKey(key: string): HandbackKey | undefined {
  const prefix = [DEDUPE_KEY_PREFIX, ASYNC_TOOL_DEDUPE_KEY_PREFIX].find(
    (candidate): boolean => key.startsWith(candidate),
  );
  if (prefix === undefined) return undefined;
  const separator = key.lastIndexOf(":");
  const status = key.slice(separator + 1);
  if (status !== "completed" && status !== "failed") return undefined;
  const id = key.slice(prefix.length, separator);
  if (id.length === 0) return undefined;

  return prefix === DEDUPE_KEY_PREFIX
    ? { kind: "subagent", eventId: id, status: status }
    : { kind: "async-tool", resultId: id, status: status };
}
