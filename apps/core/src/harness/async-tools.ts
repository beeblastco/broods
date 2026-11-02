/**
 * Async tool results that settle outside the run that started them (background
 * `bash` jobs, open questions): the recovery sweep over results no live run
 * delivered, and the message that hands a settled result back to the parent
 * conversation. The rows themselves live in `async-tool-result.ts`.
 */

import { SWEPT_HANDBACKS } from "@broods/convex/model/subagentResults";
import type { JSONValue, UserModelMessage } from "ai";
import { toErrorMessage } from "../shared/errors.ts";
import { logError, logInfo } from "../shared/log.ts";
import {
  listOwedAsyncToolResults,
  markAsyncToolHandback,
  type AsyncToolResultRecord,
} from "./async-tool-result.ts";
import type { ContinuationOutcome } from "./responses.ts";
import { lostResultWindows } from "./subagents.ts";
import {
  modelValueToUserParts,
  prependTextToUserParts,
} from "./tools/utils.ts";

/** Resumes a conversation with a settled row; the handler's `continueAfterAsyncToolSettlement`. */
export type AsyncToolSettlementResumer = (
  settled: AsyncToolResultRecord,
) => Promise<ContinuationOutcome>;

export interface AsyncToolCompletion {
  resultId: string;
  toolName: string;
  input: unknown;
  status: "completed" | "failed";
  response?: JSONValue;
  error?: string;
}

/**
 * Resumes each conversation whose async tool result no live run delivered:
 * the run that detached it died with its pod or its resume failed, or the
 * result is still `pending` past any live run's hold, because the run that
 * owed it died before its write and its detach. Each pass walks every page,
 * so rows it must retry never crowd the rest out. The ingress recovery sweep
 * calls it on its timer, after the subagent pass.
 */
export async function resumeLostAsyncToolResults(
  resumeConversation: AsyncToolSettlementResumer,
): Promise<void> {
  const now = Date.now();
  const { updatedAfter, finishedBefore } = lostResultWindows(now);
  for (const handback of SWEPT_HANDBACKS) {
    for (const status of ["completed", "failed"] as const) {
      let cursor: string | null = null;
      let isDone = false;
      while (!isDone) {
        const result = await listOwedAsyncToolResults({
          handback: handback,
          status: status,
          updatedAfter: updatedAfter,
          updatedBefore: finishedBefore(handback),
          cursor: cursor,
        });
        for (const row of result.page) {
          const handled = await resumeLostAsyncToolResult(
            row,
            resumeConversation,
          );
          // Counted once it is handled: each one is a result a run dropped
          // without a trace. A row kept for the next pass is not counted
          // again each pass.
          if (handled && handback === "pending") {
            logInfo("Async tool result left pending past the run's hold", {
              resultId: row.resultId,
              toolName: row.toolName,
              ageMs: now - Date.parse(row.updatedAt),
              outcome: row.status,
            });
          }
        }
        cursor = result.cursor;
        isDone = result.isDone;
      }
    }
  }
}

/** Formats an async tool result as the user message injected into the parent; the handler's continuation run uses it. */
export function completionToParentMessage(
  completion: AsyncToolCompletion,
): UserModelMessage {
  const metadata = [
    `statusId: ${completion.resultId}`,
    `toolName: ${completion.toolName}`,
    `status: ${completion.status}`,
  ].join("\n");
  const resultParts =
    completion.status === "completed" && completion.response !== undefined
      ? modelValueToUserParts(completion.response)
      : [];
  const prefix = `Async tool result injected into parent conversation.\n${metadata}\n\nInput:\n${formatUnknown(completion.input)}\n\nResult:\n`;

  return {
    role: "user",
    content:
      resultParts.length > 0
        ? prependTextToUserParts(prefix, resultParts)
        : [
            {
              type: "text",
              text: `${prefix}${completion.error ?? "(no result)"}`,
            },
          ],
  };
}

/**
 * One row of `resumeLostAsyncToolResults`: its continuation is admitted under
 * the row and stored by its owner's save, or refused as a duplicate once the
 * conversation has it. A conversation with no room keeps the row for the next
 * pass, and so do a resume that throws and a duplicate: admission already
 * marked a stored result, and a continuation still queued or applied is
 * stored by its owner's save, or admitted again by a later pass once it
 * expired. A row no
 * resume can ever deliver is marked stored and logged once.
 * @returns whether the row is handled, rather than kept for the next pass
 */
async function resumeLostAsyncToolResult(
  row: AsyncToolResultRecord,
  resumeConversation: AsyncToolSettlementResumer,
): Promise<boolean> {
  let outcome: ContinuationOutcome;
  try {
    outcome = await resumeConversation(row);
  } catch (error) {
    logError("Failed to resume a conversation with a lost async tool result", {
      resultId: row.resultId,
      error: toErrorMessage(error),
    });

    return false;
  }
  const admission = outcome.kind === "ready" ? outcome.admission : "skip";
  if (admission === "owner" || admission === "queued") {
    logInfo("Resumed a conversation with a lost async tool result", {
      parentEventId: row.parentEventId,
      resultId: row.resultId,
      admission: admission,
    });

    return true;
  }
  if (admission === "capacity" || admission === "duplicate") return false;
  await markAsyncToolHandback(row.resultId, "stored");
  logInfo("Gave up on a lost async tool result", {
    resultId: row.resultId,
    reason: `resume ${admission}`,
  });

  return true;
}

/** Renders a tool input as text for the injected parent message. */
function formatUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
