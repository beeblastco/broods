import { v, type Infer } from "convex/values";
import type { Doc } from "../_generated/dataModel";

const DEDUPE_KEY_PREFIX = "subagent:";

/**
 * Where a finished subagent result stands with its parent. `pending`: the
 * child finished and the parent's live run still owes it the write.
 * `detached`: that run gave up (its write failed or it stopped waiting), so
 * the recovery sweep delivers it. `stored`: the parent's conversation holds it,
 * or the parent read it, and nothing delivers it again.
 */
export const handbackValidator = v.union(
  v.literal("pending"),
  v.literal("detached"),
  v.literal("stored"),
);
export type Handback = Infer<typeof handbackValidator>;
/** The status a hand-back key names: only a finished result is owed. */
type HandbackStatus = "completed" | "failed";

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
export function parseHandbackDedupeKey(
  key: string,
): { eventId: string; status: HandbackStatus } | undefined {
  if (!key.startsWith(DEDUPE_KEY_PREFIX)) return undefined;
  const separator = key.lastIndexOf(":");
  const status = key.slice(separator + 1);
  if (status !== "completed" && status !== "failed") return undefined;
  const eventId = key.slice(DEDUPE_KEY_PREFIX.length, separator);
  if (eventId.length === 0) return undefined;

  return { eventId: eventId, status: status };
}
