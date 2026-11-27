import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as harness from "../../../../apps/core/src/harness/harness.ts";
import * as ingress from "../../../../apps/core/src/harness/ingress.ts";
import type { ChannelInboundEvent } from "../../../../apps/core/src/harness/integrations.ts";
import { Session } from "../../../../apps/core/src/harness/session.ts";
import { runtime } from "../../../../apps/core/src/shared/convex/runtime.ts";
import {
  getStorage,
  resetStorageForTests,
} from "../../../../apps/core/src/shared/storage.ts";

const { handleChannelRequest } =
  await import("../../../../apps/core/src/harness/handler.ts");
const { drainInProcessWorkers } =
  await import("../../../../apps/core/src/harness/worker-queue.ts");

type Callbacks = Parameters<typeof harness.runAgentLoop>[3];
type Stream = Awaited<ReturnType<typeof harness.runAgentLoop>>;

const sent: string[] = [];
const stored: { name: string; args: unknown }[] = [];

function channelMessage(trace: "enabled" | "disabled"): ChannelInboundEvent {
  return {
    accountId: "acct_1",
    agentId: "agent_1",
    eventId: "channel-event-1",
    conversationKey: "acct:acct_1:agent:agent_1:tg:1",
    content: "hi",
    events: [{ role: "user", content: "hi" }],
    channelName: "telegram",
    source: { chatId: 1 },
    agentConfig: { channels: { telegram: { trace: trace } } },
    projectSlug: "shop",
    stageSlug: "dev",
    channel: {
      sendText: async (text): Promise<void> => {
        sent.push(text);
      },
      sendTyping: async (): Promise<void> => {},
      reactToMessage: async (): Promise<void> => {},
    },
  } as ChannelInboundEvent;
}

function loopThatCalls(
  script: (callbacks: Callbacks) => Promise<void>,
  traceId?: string,
): void {
  spyOn(harness, "runAgentLoop").mockImplementation(
    async (_session, _turn, _config, callbacks): Promise<Stream> => {
      await script(callbacks);

      return {
        traceId: (): string | undefined => traceId,
        consumeStream: async (): Promise<void> => {},
        questionSummaries: (): [] => [],
        didFail: (): boolean => false,
        yielded: (): boolean => false,
        failureText: (): null => null,
      } as unknown as Stream;
    },
  );
}

async function run(trace: "enabled" | "disabled"): Promise<void> {
  await handleChannelRequest(channelMessage(trace));
  await drainInProcessWorkers();
}

beforeEach((): void => {
  const storage = getStorage();
  spyOn(storage.accounts, "getById").mockResolvedValue({
    accountId: "acct_1",
    username: "ada",
    secretHash: "hash",
    status: "active",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  });
  spyOn(storage.budgets, "get").mockResolvedValue(null);
  spyOn(runtime, "mutate").mockImplementation(
    async (name, args): Promise<null> => {
      stored.push({ name: name, args: args });

      return null;
    },
  );
  spyOn(runtime, "query").mockResolvedValue([]);
  spyOn(ingress, "acceptIngress").mockResolvedValue({
    outcome: "owner",
    ownerGeneration: 1,
  });
  spyOn(ingress, "settleIngress").mockResolvedValue(1);
  spyOn(Session.prototype, "assertCurrentOwner").mockResolvedValue();
  spyOn(Session.prototype, "createTurnContext").mockImplementation(
    async (): ReturnType<Session["createTurnContext"]> => ({
      messages: [{ role: "user", content: "hi" }],
      system: [],
      ephemeralSystem: [],
      systemContextSnapshot: { cursor: null, messages: [] },
    }),
  );
});

afterEach((): void => {
  sent.length = 0;
  stored.length = 0;
  delete process.env.BROODS_DASHBOARD_URL;
  spyOn(harness, "runAgentLoop").mockRestore();
  resetStorageForTests();
});

describe("a channel reply with tracing enabled", (): void => {
  test("ends with a link to the trace in the dashboard", async (): Promise<void> => {
    loopThatCalls(
      (callbacks): Promise<void> => callbacks.onFinalText("the answer  "),
      "trace_1",
    );

    await run("enabled");

    expect(sent).toEqual([
      "the answer\n\nTrace: https://dashboard.broods.app?project=shop&stage=dev&tab=tracing&trace=trace_1",
    ]);
  });

  test("uses the dashboard the operator configured, without trailing slashes", async (): Promise<void> => {
    process.env.BROODS_DASHBOARD_URL = "https://dash.example.test//";
    loopThatCalls(
      (callbacks): Promise<void> => callbacks.onFinalText("ok"),
      "trace/2",
    );

    await run("enabled");

    expect(sent).toEqual([
      "ok\n\nTrace: https://dash.example.test?project=shop&stage=dev&tab=tracing&trace=trace%2F2",
    ]);
  });

  test("has no link when the run left no trace id, or tracing is off", async (): Promise<void> => {
    loopThatCalls((callbacks): Promise<void> => callbacks.onFinalText("plain"));
    await run("enabled");
    loopThatCalls(
      (callbacks): Promise<void> => callbacks.onFinalText("plain"),
      "trace_1",
    );
    await run("disabled");

    expect(sent).toEqual(["plain", "plain"]);
  });
});

describe("a channel turn that needs approval", (): void => {
  test("denies every pending tool call, since a channel cannot approve", async (): Promise<void> => {
    let passes = 0;
    loopThatCalls(async (callbacks): Promise<void> => {
      passes += 1;
      if (passes === 1) {
        await callbacks.onApprovalRequired?.([
          { approvalId: "ap_1", toolCallId: "c1", toolName: "bash", input: {} },
          {
            approvalId: "ap_2",
            toolCallId: "c2",
            toolName: "write",
            input: {},
          },
        ] as never);
        return;
      }
      await callbacks.onFinalText("done");
    });

    await run("disabled");

    const denials = stored
      .map((call): string => JSON.stringify(call.args))
      .filter((text): boolean => text.includes("tool-approval-response"));
    expect(denials).toHaveLength(1);
    expect(denials[0]).toContain('"approvalId":"ap_1","approved":false');
    expect(denials[0]).toContain('"approvalId":"ap_2","approved":false');
    expect(passes).toBe(2);
    expect(sent).toEqual(["done"]);
  });
});
