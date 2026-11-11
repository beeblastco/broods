import { expect, test } from "bun:test";
import { BroodsClient } from "../src/index.ts";

const BUSY =
  "Conversation is already processing another turn. Try again when the current turn finishes.";
const BUSY_FRAME = `data: {"type":"error","error":"${BUSY}","code":"conversation_busy","errorType":"conflict_error"}\n\n`;
const OLD_CORE_BUSY_FRAME = `data: {"type":"error","error":"${BUSY}"}\n\n`;

test("a streamed run refused before it starts throws the frame's code and type", async (): Promise<void> => {
  await expect(
    refusedRun(BUSY_FRAME).run({ agentId: "agent_1", input: "hello" }),
  ).rejects.toMatchObject({
    name: "BroodsApiError",
    message: `Run failed: 409 ${BUSY} (conversation_busy)`,
    status: 409,
    code: "conversation_busy",
    type: "conflict_error",
    serverMessage: BUSY,
  });
});

test("an older core's refusal frame still throws BroodsApiError, with no code", async (): Promise<void> => {
  const error: unknown = await refusedRun(OLD_CORE_BUSY_FRAME)
    .run({ agentId: "agent_1", input: "hello" })
    .catch((caught: unknown): unknown => caught);

  expect(error).toMatchObject({
    name: "BroodsApiError",
    message: `Run failed: 409 ${BUSY}`,
    status: 409,
    serverMessage: BUSY,
  });
  expect(error).toHaveProperty("code", undefined);
});

// Runs on the released SDK too (`with-base.sh`): the new fields must not change what it threw.
test("the coded refusal frame keeps the status and message an older SDK reports", async (): Promise<void> => {
  await expect(
    refusedRun(BUSY_FRAME).run({ agentId: "agent_1", input: "hello" }),
  ).rejects.toThrow(`Run failed: 409`);
  await expect(
    refusedRun(BUSY_FRAME).run({ agentId: "agent_1", input: "hello" }),
  ).rejects.toThrow(BUSY);
});

function refusedRun(frame: string): BroodsClient {
  return new BroodsClient({
    apiKey: "test-key",
    fetch: async (): Promise<Response> =>
      new Response(frame, {
        status: 409,
        headers: { "content-type": "text/event-stream" },
      }),
  });
}
