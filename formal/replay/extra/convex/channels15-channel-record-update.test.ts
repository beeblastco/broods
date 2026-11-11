import { describe, expect, test } from "bun:test";
import { normalizeUpdateChannelRecordInput } from "../../../../packages/convex/model/channelRules.ts";

describe("normalizeUpdateChannelRecordInput", (): void => {
  test("trims a new name", (): void => {
    expect(normalizeUpdateChannelRecordInput({ name: "  Support  " })).toEqual({
      name: "Support",
    });
  });

  test("normalizes a new config", (): void => {
    expect(
      normalizeUpdateChannelRecordInput({
        config: {
          agentBindings: [{ agentId: " agent_1 ", isDefault: true }],
          instructions: "  Be brief.  ",
        },
      }),
    ).toEqual({
      config: {
        agentBindings: [{ agentId: "agent_1", isDefault: true }],
        instructions: "Be brief.",
      },
    });
  });

  test("passes a status through", (): void => {
    expect(normalizeUpdateChannelRecordInput({ status: "deleted" })).toEqual({
      status: "deleted",
    });
  });
});
