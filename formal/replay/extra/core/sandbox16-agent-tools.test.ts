import { afterEach, describe, expect, test } from "bun:test";

import loadSkillTool from "../../../../apps/core/src/harness/tools/load-skill.tool.ts";
import messageAgentsTool from "../../../../apps/core/src/harness/tools/message-agents.tool.ts";
import {
  cancelScheduleTool,
  updateScheduleTool,
} from "../../../../apps/core/src/harness/tools/schedule.tool.ts";
import type {
  AgentMessage,
  AgentMessageResult,
  ParentLink,
} from "../../../../apps/core/src/harness/tools/utils.ts";
import type { Session } from "../../../../apps/core/src/harness/session.ts";
import {
  resetStorageForTests,
  setStorageForTests,
} from "../../../../apps/core/src/shared/storage.ts";

const OPTIONS = { toolCallId: "c", messages: [] };
const DELIVERED: AgentMessageResult = {
  status: "delivered",
  exchangeId: "ex_1",
  note: "ok",
};

afterEach((): void => {
  resetStorageForTests();
});

function failing(message: string): () => Promise<never> {
  return async (): Promise<never> => {
    throw new Error(message);
  };
}

describe("loadSkillTool execute", (): void => {
  const session = {
    accountId: "acct_1",
    agentId: "a1",
    eventId: "evt_1",
  } as unknown as Session;

  function load(input: object, prompt: () => Promise<never>): Promise<unknown> {
    const tools = loadSkillTool(session, prompt as never);

    return Promise.resolve(tools.load_skill?.execute?.(input, OPTIONS));
  }

  test("a path is required", async (): Promise<void> => {
    await expect(load({}, failing("unused"))).rejects.toThrow(
      "path is required",
    );
  });

  test("resources must be strings", async (): Promise<void> => {
    await expect(
      load({ path: "acct/skill", resources: ["a", 2] }, failing("unused")),
    ).rejects.toThrow("resources must be an array of strings");
    await expect(
      load({ path: "acct/skill", resources: "a" }, failing("unused")),
    ).rejects.toThrow("resources must be an array of strings");
  });

  test("a failed load is rethrown", async (): Promise<void> => {
    await expect(
      load({ path: "acct/skill" }, failing("skill missing")),
    ).rejects.toThrow("skill missing");
  });
});

describe("messageAgentsTool execute", (): void => {
  function send(
    context: Parameters<typeof messageAgentsTool>[0],
    input: object,
  ): Promise<unknown> {
    return Promise.resolve(
      messageAgentsTool(context)["message-agents"]?.execute?.(input, OPTIONS),
    );
  }

  test("a blank text is refused", async (): Promise<void> => {
    await expect(send({}, { to: "parent", text: " " })).rejects.toThrow(
      "requires a non-empty text",
    );
  });

  test("an agent with no parent cannot message one", async (): Promise<void> => {
    await expect(send({}, { to: "parent", text: "hi" })).rejects.toThrow(
      "you have no parent agent to message",
    );
  });

  test("waiting on the parent twice in a turn is refused", async (): Promise<void> => {
    const parent: ParentLink = {
      ask: (): boolean => false,
      note: async (): Promise<AgentMessageResult> => DELIVERED,
    };

    await expect(
      send({ parent: parent }, { to: "parent", text: "hi", waitSeconds: 5 }),
    ).rejects.toThrow("you already wait on your parent this turn");
  });

  test("a child address with no child link is refused", async (): Promise<void> => {
    await expect(send({}, { to: "child-1", text: "hi" })).rejects.toThrow(
      'is not an agent you can message. Use "parent"',
    );
  });

  test("a child message keeps its follow-up and clamped wait", async (): Promise<void> => {
    const seen: AgentMessage[] = [];

    const result = await send(
      {
        messageChild: async (
          _to: string,
          message: AgentMessage,
        ): Promise<AgentMessageResult> => {
          seen.push(message);

          return DELIVERED;
        },
      },
      { to: " child-1 ", text: " hi ", followUp: " ex_9 ", waitSeconds: 0.2 },
    );

    expect(result).toEqual(DELIVERED);
    expect(seen).toEqual([
      { text: "hi", exchangeId: "ex_9", followUp: true, waitSeconds: 1 },
    ]);
  });
});

describe("schedule tools", (): void => {
  const context = {
    accountId: "acct_1",
    agentId: "a1",
    conversationKey: "conv_1",
  };

  function crons(parts: object): void {
    setStorageForTests({ crons: parts } as never);
  }

  test("a lookup that fails is reported, not taken for a missing task", async (): Promise<void> => {
    crons({
      getById: failing("bad id"),
    });

    await expect(
      Promise.resolve(
        cancelScheduleTool(context).cancel_schedule?.execute?.(
          { cronId: "cron_1" },
          OPTIONS,
        ),
      ),
    ).rejects.toThrow("bad id");
    await expect(
      Promise.resolve(
        updateScheduleTool(context).update_schedule?.execute?.(
          { cronId: "cron_1", status: "paused" },
          OPTIONS,
        ),
      ),
    ).rejects.toThrow("bad id");
  });

  test("a task that vanishes during the update is reported", async (): Promise<void> => {
    crons({
      getById: async (): Promise<object> => ({
        cronId: "cron_1",
        agentId: "a1",
        conversationKey: "conv_1",
      }),
      update: async (): Promise<null> => null,
    });

    await expect(
      Promise.resolve(
        updateScheduleTool(context).update_schedule?.execute?.(
          { cronId: "cron_1", status: "paused" },
          OPTIONS,
        ),
      ),
    ).rejects.toThrow("Scheduled task cron_1 no longer exists");
  });
});
