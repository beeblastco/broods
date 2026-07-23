/**
 * Terminal ingress orchestration tests.
 * Cover transfer-before-release behavior shared by direct and NATS failures.
 */

import { describe, expect, it } from "bun:test";
import type { Session } from "../src/harness/session.ts";

process.env.CONVERSATIONS_TABLE_NAME ??= "conversations";
process.env.PROCESSED_EVENTS_TABLE_NAME ??= "processed-events";
process.env.ASYNC_AGENT_RESULT_TABLE_NAME ??= "async-agent-result";
process.env.ASYNC_TOOL_RESULT_TABLE_NAME ??= "async-tool-result";

const { settleFailedIngressAndDrain } =
  await import("../src/harness/handler.ts");

type TerminalSession = Pick<
  Session,
  "releaseConversationLease" | "settleIngress"
>;

function terminalSession(actions: string[]): TerminalSession {
  return {
    releaseConversationLease: async () => {
      actions.push("release");
    },
    settleIngress: async (status, options) => {
      actions.push(`settle:${status}:${options?.error}`);
    },
  };
}

describe("terminal ingress draining", () => {
  it("keeps the lease transferred when queued work is dispatched", async () => {
    const actions: string[] = [];

    const transferred = await settleFailedIngressAndDrain(
      terminalSession(actions),
      "stream failed",
      async () => {
        actions.push("dispatch");
        return true;
      },
    );

    expect(transferred).toBe(true);
    expect(actions).toEqual(["settle:failed:stream failed", "dispatch"]);
  });

  it("releases the lease when queued-work dispatch fails", async () => {
    const actions: string[] = [];

    const transferred = await settleFailedIngressAndDrain(
      terminalSession(actions),
      "stream failed",
      async () => {
        actions.push("dispatch");
        throw new Error("dispatch failed");
      },
    );

    expect(transferred).toBe(false);
    expect(actions).toEqual([
      "settle:failed:stream failed",
      "dispatch",
      "release",
    ]);
  });
});
