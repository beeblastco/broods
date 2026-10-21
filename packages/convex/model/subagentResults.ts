import { v, type Infer, type VLiteral } from "convex/values";
import type { Doc } from "../_generated/dataModel";

const DEDUPE_KEY_PREFIX = "subagent:";
const ASYNC_TOOL_DEDUPE_KEY_PREFIX = "async-tool:";

/**
 * Where a finished result stands with the conversation it is owed to: a
 * subagent's with its parent, an async tool's with the run that started it.
 * `pending`: it finished and the live run still owes it the write.
 * `detached`: that run gave up (its write failed or it stopped waiting), so
 * the recovery sweep delivers it. `stored`: the conversation holds it, or the
 * model read it, and nothing delivers it again.
 */
export const handbackValidator = v.union(
  v.literal("pending"),
  v.literal("detached"),
  v.literal("stored"),
);
export type Handback = Infer<typeof handbackValidator>;
/**
 * The hand-backs the recovery sweeps list, each in its own window: a result no
 * conversation stores yet. Core's subagent and async tool sweeps walk this list.
 */
export const SWEPT_HANDBACKS = ["detached", "pending"] as const;
export type SweptHandback = (typeof SWEPT_HANDBACKS)[number];
export const sweptHandbackValidator = v.union(
  ...SWEPT_HANDBACKS.map((handback): VLiteral<SweptHandback> =>
    v.literal(handback),
  ),
);
/** The hand-backs a run or a read moves a finished result to. */
export const handbackMoveValidator = v.union(
  v.literal("detached"),
  v.literal("stored"),
);
export type HandbackMove = Infer<typeof handbackMoveValidator>;
/** The status a hand-back key names: only a finished result is owed. */
type HandbackStatus = "completed" | "failed";
/** The result row a stored dedupe key names: a subagent's, or an async tool's. */
export type HandbackKey =
  | { kind: "subagent"; eventId: string; status: HandbackStatus }
  | { kind: "async-tool"; resultId: string; status: HandbackStatus };

/**
 * The dedupe key core stores an async tool result under in its parent's
 * conversation. Core writes it with the result; `runtimeIngress.accept`
 * looks it up, so a late resume never repeats a result the parent has.
 */
export function asyncToolResultDedupeKey(
  resultId: string,
  status: HandbackStatus,
): string {
  return `${ASYNC_TOOL_DEDUPE_KEY_PREFIX}${resultId}:${status}`;
}

/**
 * The dedupe key core stores a subagent result under in its parent's
 * conversation. Core writes it with the result; `runtimeIngress.accept`
 * looks it up, so a late resume never repeats a result the parent has.
 */
export function subagentResultDedupeKey(
  eventId: string,
  status: Doc<"runtimeAsyncAgentResults">["status"] | "running",
): string {
  return `${DEDUPE_KEY_PREFIX}${eventId}:${status}`;
}

/**
 * The result row and outcome a stored dedupe key names, so the insert that
 * stores the row marks the hand-back done. A running notice, or any other
 * key, is nobody's hand-back and parses to undefined.
 */
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
