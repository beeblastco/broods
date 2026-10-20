/**
 * Usage writes share rollups and an audit head. Exercise the real HTTP client's
 * queue so concurrent runs cannot race those writes within the core process.
 */

import { afterEach, expect, it, spyOn } from "bun:test";
import { resetConvexClientForTests } from "../src/shared/convex/client.ts";
import { taskUsage } from "../src/shared/convex/usage.ts";
import type { TaskUsageInput } from "../src/shared/storage.ts";

const savedEnv = { ...process.env };

afterEach((): void => {
  process.env = { ...savedEnv };
  resetConvexClientForTests();
});

it("queues concurrent task usage writes until the preceding write settles", async (): Promise<void> => {
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
  const second = taskUsage.record({ ...input, taskId: "task_2" });
  try {
    await Bun.sleep(0);
    expect(requests).toBe(1);
  } finally {
    release.resolve();
    await Promise.all([first, second]);
    fetch.mockRestore();
  }
  expect(requests).toBe(2);
});
