/**
 * The schedule tools' input schemas, run the way the SDK runs them before
 * `execute`: a call the schema refuses goes back to the model to retry.
 */

import { describe, expect, it } from "bun:test";
import { asSchema, type ToolSet } from "ai";
import {
  scheduleTool,
  updateScheduleTool,
} from "../src/harness/tools/schedule.tool.ts";

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
    // The config plane stores instructions as they come, so blank ones would
    // fire as an empty task.
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

/** The SDK's own check for one tool's input. */
function validator(
  tools: ToolSet,
  name: string,
): (
  value: unknown,
) => Promise<{ success: true; value: unknown } | { success: false }> {
  const schema = asSchema(tools[name]!.inputSchema);

  return async (value) => schema.validate!(value);
}
