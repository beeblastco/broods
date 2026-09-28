import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import type { ChannelRequest } from "../src/shared/channels.ts";
import { createSlackChannel } from "../src/shared/slack-channel.ts";

const SIGNING_SECRET = "signing-secret";
const STATUS_ID = "async_tool_2f1c9a9e-8d2f-4a7b-9c3d-0e1f2a3b4c5d";
const THREAD_TS = "1713916800.000001";

interface SlackCall {
  url: string;
  body: Record<string, unknown>;
}

const adapter = createSlackChannel(
  "bot-token",
  SIGNING_SECRET,
  null,
  null,
  "eyes",
  undefined,
  async () => null,
);

describe("slack ask_questions", () => {
  it("posts the numbered text with one button per option", async () => {
    const actions = adapter.actions({
      eventId: "slack:T1:C1:1",
      conversationKey: `slack:T1:C1:${THREAD_TS}`,
      channelName: "slack",
      content: "hi",
      source: {
        teamId: "T1",
        channelId: "C1",
        threadTs: THREAD_TS,
        messageTs: THREAD_TS,
        userId: "U1",
      },
    });

    const calls = await withSlackApi(() =>
      actions.sendQuestions!({
        statusId: STATUS_ID,
        text: "Which stage?\n1. dev\n2. prod",
        questions: [
          {
            id: "deploy_target",
            header: "Target",
            question: "Which stage?",
            options: [{ label: "dev" }, { label: "prod" }],
          },
        ],
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("chat.postMessage");
    expect(calls[0]!.body).toMatchObject({
      channel: "C1",
      thread_ts: THREAD_TS,
    });
    const blocks = calls[0]!.body.blocks as Array<Record<string, unknown>>;
    expect(blocks.find((block) => block.type === "actions")).toMatchObject({
      elements: [
        { action_id: `q:${STATUS_ID}:0:0`, value: THREAD_TS },
        { action_id: `q:${STATUS_ID}:0:1`, value: THREAD_TS },
      ],
    });
  });

  it("turns a click into an answer on the thread's conversation and swaps the buttons for it", async () => {
    let parsed: Awaited<ReturnType<typeof adapter.parse>> | undefined;
    const calls = await withSlackApi(async (): Promise<void> => {
      parsed = await adapter.parse(
        blockActionsRequest({
          type: "block_actions",
          trigger_id: "trigger-1",
          response_url: "https://hooks.slack.com/actions/T1/1/abc",
          team: { id: "T1" },
          user: { id: "U1", username: "ann" },
          channel: { id: "C1" },
          container: {
            channel_id: "C1",
            message_ts: "1713916800.000009",
            thread_ts: THREAD_TS,
          },
          message: {
            ts: "1713916800.000009",
            thread_ts: THREAD_TS,
            blocks: [
              { type: "section", text: { type: "mrkdwn", text: "Which?" } },
            ],
          },
          actions: [
            {
              type: "button",
              action_id: `q:${STATUS_ID}:0:1`,
              value: THREAD_TS,
              text: { type: "plain_text", text: "prod" },
            },
          ],
        }),
      );
    });

    expect(parsed?.kind).toBe("message");
    if (parsed?.kind !== "message") throw new Error("expected a message");
    expect(parsed.message.conversationKey).toBe(`slack:T1:C1:${THREAD_TS}`);
    expect(parsed.message.answer).toEqual({
      statusId: STATUS_ID,
      questionIndex: 0,
      optionIndex: 1,
    });
    expect(parsed.message.identity).toMatchObject({
      channelId: "C1",
      userId: "U1",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://hooks.slack.com/actions/T1/1/abc");
    expect(calls[0]!.body).toMatchObject({ replace_original: true });
    expect(JSON.stringify(calls[0]!.body.blocks)).toContain("*prod*");
  });

  it("answers a click in a DM on the DM's conversation", async () => {
    const parsed = await adapter.parse(
      blockActionsRequest({
        type: "block_actions",
        team: { id: "T1" },
        user: { id: "U1" },
        channel: { id: "D1" },
        container: { channel_id: "D1", message_ts: "1713916800.000009" },
        actions: [{ type: "button", action_id: `q:${STATUS_ID}:0:0` }],
      }),
    );

    if (parsed.kind !== "message") throw new Error("expected a message");
    expect(parsed.message.conversationKey).toBe("slack:T1:D1");
  });

  it("drops an action that is not a question button", async () => {
    const parsed = await adapter.parse(
      blockActionsRequest({
        type: "block_actions",
        team: { id: "T1" },
        user: { id: "U1" },
        channel: { id: "C1" },
        actions: [{ type: "button", action_id: "something-else" }],
      }),
    );

    expect(parsed.kind).toBe("ignore");
  });
});

function blockActionsRequest(payload: Record<string, unknown>): ChannelRequest {
  const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const timestamp = `${Math.floor(Date.now() / 1000)}`;
  const signature = createHmac("sha256", SIGNING_SECRET)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex");

  return {
    method: "POST",
    rawPath: "/v1/webhooks/acct/slack",
    rawQueryString: "",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": `v0=${signature}`,
    },
    body: body,
  };
}

// Web API calls are form encoded with JSON-encoded blocks; response_url
// calls are JSON.
function slackBody(raw: string): Record<string, unknown> {
  if (raw.startsWith("{")) return JSON.parse(raw) as Record<string, unknown>;
  const params = Object.fromEntries(new URLSearchParams(raw));

  return {
    ...params,
    ...(params.blocks ? { blocks: JSON.parse(params.blocks) as unknown } : {}),
  };
}

// Captures every Slack call made while `run` executes, including the
// fire-and-forget answer update, which a timer tick lets land.
async function withSlackApi(run: () => Promise<void>): Promise<SlackCall[]> {
  const calls: SlackCall[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    calls.push({
      url: input instanceof Request ? input.url : String(input),
      body: slackBody(String(init?.body)),
    });

    return new Response(JSON.stringify({ ok: true, ts: "1.2" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  try {
    await run();
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    globalThis.fetch = originalFetch;
  }

  return calls;
}
