// The real HTTP client's queue: concurrent usage writes share rollups and an audit head.

import { afterEach, expect, it, spyOn } from "bun:test";
import { auditLedger } from "../src/shared/convex/audit-ledger.ts";
import { resetConvexClientForTests } from "../src/shared/convex/client.ts";
import { taskUsage } from "../src/shared/convex/usage.ts";
import type { TaskUsageInput } from "../src/shared/storage.ts";

const savedEnv = { ...process.env };

afterEach((): void => {
  process.env = { ...savedEnv };
  resetConvexClientForTests();
});

it.each(["usage", "audit"] as const)(
  "queues a concurrent %s write behind task usage",
  async (kind): Promise<void> => {
    process.env.CONVEX_URL = "https://convex.example.com";
    process.env.CONVEX_DEPLOY_KEY = "dev:test|key";
    resetConvexClientForTests();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let requests = 0;
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (): Promise<Response> => {
          requests += 1;
          if (requests === 1) {
            started.resolve();
            await release.promise;
          }

          return Response.json({ status: "success", value: null });
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    const input: TaskUsageInput = {
      accountId: "acct_1",
      agentId: "agent_1",
      conversationKey: "conversation_1",
      taskId: "task_1",
      modelProvider: "anthropic",
      modelId: "test",
      finishedAt: 1,
      durationMs: 1,
      status: "completed",
      inputTokens: 1,
      outputTokens: 1,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 2,
      runtimeKind: "container",
      runtimeWallMs: 1,
      runtimeMemoryMb: 1,
      sandboxUsage: [],
      stepCount: 1,
      toolCallCount: 0,
    };
    const first = taskUsage.record(input);
    await started.promise;
    const second =
      kind === "usage"
        ? taskUsage.record({ ...input, taskId: "task_2" })
        : auditLedger.append({
            accountId: input.accountId,
            agentId: input.agentId,
            action: "tool.denied",
            resource: { kind: "tool", name: "bash" },
            summary: "Denied by policy",
          });
    try {
      await Bun.sleep(0);
      expect(requests).toBe(1);
    } finally {
      release.resolve();
      await Promise.all([first, second]);
      fetch.mockRestore();
    }
    expect(requests).toBe(2);
  },
);
