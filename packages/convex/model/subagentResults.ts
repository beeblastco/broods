import type { Doc } from "../_generated/dataModel";

/**
 * The dedupe key core stores a subagent result under in its parent's
 * conversation. Core writes it with the result; `runtimeIngress.accept`
 * looks it up, so a late resume never repeats a result the parent has.
 */

export function subagentResultDedupeKey(
  eventId: string,
  status: Doc<"runtimeAsyncAgentResults">["status"] | "running",
): string {
  return `subagent:${eventId}:${status}`;
}
