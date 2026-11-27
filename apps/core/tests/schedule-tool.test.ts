import { describe, expect, it } from "bun:test";
import { asSchema, type ToolSet } from "ai";
import {
  cancelScheduleTool,
  scheduleTool,
  updateScheduleTool,
} from "../src/harness/tools/schedule.tool.ts";
import { setStorageForTests, type Storage } from "../src/shared/storage.ts";

const CONTEXT = {
  accountId: "acct_1",
  agentId: "agent_1",
  conversationKey: "acct:acct_1:agent:agent_1:conv",
};
const TASK = {
  name: "daily-standup-summary",
  instructions: "Summarise yesterday's standup.",
  schedule: "cron(0 9 * * ? *)",
};

describe("schedule tool input", () => {
  it("refuses a call the schema does not describe", async (): Promise<void> => {
    const validate = validator(scheduleTool(CONTEXT), "schedule");

    expect((await validate(TASK)).success).toBe(true);
    expect((await validate({ ...TASK, schedule: "every day" })).success).toBe(
      false,
    );
    expect((await validate({ ...TASK, name: "" })).success).toBe(false);
    // The config plane stores instructions as given, so blank ones would fire as an empty task.
    expect((await validate({ ...TASK, instructions: "   " })).success).toBe(
      false,
    );
    expect((await validate({ ...TASK, repeat: true })).success).toBe(false);
    expect(
      (await validate({ name: TASK.name, schedule: TASK.schedule })).success,
    ).toBe(false);
  });

  it("hands execute a trimmed schedule", async (): Promise<void> => {
    const validate = validator(scheduleTool(CONTEXT), "schedule");
    const result = await validate({ ...TASK, schedule: " rate(2 hours) " });

    expect(result.success && result.value).toMatchObject({
      schedule: "rate(2 hours)",
    });
  });

  it("refuses a blank id or an unknown status on update", async (): Promise<void> => {
    const validate = validator(updateScheduleTool(CONTEXT), "update_schedule");

    expect(
      (await validate({ cronId: " cron_1 ", status: "paused" })).success,
    ).toBe(true);
    expect((await validate({ cronId: "  ", status: "paused" })).success).toBe(
      false,
    );
    expect(
      (await validate({ cronId: "cron_1", status: "deleted" })).success,
    ).toBe(false);
  });
});

describe("schedule tools on a config plane outage", () => {
  it("fail the call instead of reporting the task missing", async (): Promise<void> => {
    setStorageForTests({
      crons: {
        getById: async (): Promise<never> => {
          throw new Error("Convex unavailable");
        },
      },
    } as unknown as Storage);
    try {
      await expect(
        execute(cancelScheduleTool(CONTEXT), "cancel_schedule", {
          cronId: "cron_1",
        }),
      ).rejects.toThrow("Convex unavailable");
      await expect(
        execute(updateScheduleTool(CONTEXT), "update_schedule", {
          cronId: "cron_1",
          status: "paused",
        }),
      ).rejects.toThrow("Convex unavailable");
    } finally {
      setStorageForTests(null);
    }
  });
});

async function execute(
  tools: ToolSet,
  name: string,
  input: unknown,
): Promise<unknown> {
  return await tools[name]!.execute!(input as never, {
    toolCallId: "call-1",
    messages: [],
    context: {},
  });
}

function validator(
  tools: ToolSet,
  name: string,
): (
  value: unknown,
) => Promise<{ success: true; value: unknown } | { success: false }> {
  const schema = asSchema(tools[name]!.inputSchema);

  return async (value) => schema.validate!(value);
}
