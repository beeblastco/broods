/**
 * Example WebSocket stream over durable JetStream, with subagents and tools.
 *
 * Demonstrates the platform contract: responses persist on a conversation-scoped
 * stream, so a client that drops and reconnects can REPLAY from where it left
 * off. This script consumes the live stream, then re-opens a fresh reader from
 * sequence 1 to prove the stream is still replayable after the run finished —
 * the same mechanism a reconnecting browser/gateway would use. Ctrl+C to exit.
 */

import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { toRuntimeAgentConfig, type AgentConfig } from "../functions/_shared/storage/index.ts";
import { conversationBufferedCount, connectNats, readConversationStream, subscribeConversationLive, type NatsStreamEvent } from "../functions/_shared/nats.ts";
import { scopedDirectConversationKey, scopedDirectEventId } from "../functions/_shared/runtime-keys.ts";
import type { DirectInboundEvent } from "../functions/harness-processing/integrations.ts";
import { createAccount, createAgent, deleteAccount } from "./utils.ts";

const minimaxApiKey = process.env.ACCOUNT_MINIMAX_API_KEY!;
const tavilyApiKey = process.env.ACCOUNT_TAVILY_API_KEY!;
const lambdaFunctionName = process.env.HARNESS_FUNCTION_ARN!;
const natsUrl = process.env.NATS_URL!;
const natsToken = process.env.NATS_TOKEN || undefined;
const connectionId = `ws-test-${Date.now()}`;
const publicEventId = `nats-${Date.now()}`;
const publicConversationKey = `nats-${Date.now()}`;
const decoder = new TextDecoder();

// Render a stream event as the actual content forming — print delta text inline
// (so reasoning/answer read like real streaming) with light markers for the
// structural events, instead of just echoing the event type.
function renderEvent(event: NatsStreamEvent): void {
  const data = event.data as { type?: string; text?: string };
  if ((data.type === "text-delta" || data.type === "reasoning-delta") && typeof data.text === "string") {
    process.stdout.write(data.text);
    return;
  }
  if (data.type === "reasoning-start") return void process.stdout.write("\n  [reasoning] ");
  if (data.type === "text-start") return void process.stdout.write("\n  [answer] ");
  if (data.type !== "done" && data.type !== "error") process.stdout.write(`\n  · ${String(data.type)}`);
}

const researchAgentConfig: AgentConfig = {
  provider: {
    minimax: {
      apiKey: minimaxApiKey,
    },
  },
  model: {
    provider: "minimax",
    modelId: "MiniMax-M3",
  },
  agent: {
      system: `Knowledge cutoff: Janurary 2025.\n\nYou are a helpful personal assistant that can use tools to get information and perform tasks for the user.\n\nYou also have access to web search and web fetch tools. Always use these tools to research and get up-to-date information or when you are asked for. Your knowledge was limited by cutoff training data date so do not rely on it for up-to-date information or fact checks. Only research and answer the question, don't put additional information.`,
  },
  tools: {
    tavilySearch: {
      enabled: true,
      apiKey: tavilyApiKey,
      searchDepth: "advanced",
      topic: "news",
      includeAnswer: true,
      maxResults: 3,
    },
  },
};

const natsClient = await connectNats({ servers: natsUrl, token: natsToken });
const lambda = new LambdaClient({ region: "eu-central-1", profile: "default" });

const account = await createAccount(`nats-stream-${Date.now()}`);
const researchAgent = await createAgent(
  account.secret,
  "Research subagent",
  researchAgentConfig,
  "Specialized research agent",
);

const agentConfig: AgentConfig = {
  provider: {
    minimax: {
      apiKey: minimaxApiKey,
    },
  },
  model: {
    provider: "minimax",
    modelId: "MiniMax-M3",
  },
  agent: {
      system: "You are a helpful assistant.",
  },
  subagent: {
    enabled: true,
    allowed: [researchAgent.agentId],
    context: "new",
  },
};
const agent = await createAgent(account.secret, "NATS stream test assistant", agentConfig);

console.log("Created test account:", JSON.stringify(account.account));
console.log("Created research subagent:", JSON.stringify(researchAgent));
console.log("Created test agent:", JSON.stringify(agent));
console.log("Streaming conversation:", publicConversationKey);

try {
  const inboundEvent: DirectInboundEvent = {
    accountId: account.account.accountId,
    agentId: agent.agentId,
    agentConfig: toRuntimeAgentConfig(agentConfig),
    eventId: scopedDirectEventId(account.account.accountId, agent.agentId, publicEventId),
    publicEventId: publicEventId,
    conversationKey: scopedDirectConversationKey(account.account.accountId, agent.agentId, publicConversationKey),
    publicConversationKey: publicConversationKey,
    connectionId: connectionId,
    events: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              "Launch two subagents in parallel to",
              "research the newest model release from OpenAI",
              "and the newest model release from Anthropic.",
              "Compare their coding capabilities and say which is better for coding.",
            ].join(" "),
          },
        ],
      },
    ],
  };

  await lambda.send(new InvokeCommand({
    FunctionName: lambdaFunctionName,
    InvocationType: "Event",
    Payload: new TextEncoder().encode(JSON.stringify({
      kind: "nats-worker",
      event: inboundEvent,
    })),
  }));

  // Phase 1 — LIVE via core subscribe, then simulate a mid-stream DISCONNECT.
  // The user is watching tokens arrive; after a few we "drop" (close the socket)
  // while the agent keeps streaming server-side. Track the last envelope sequence
  // so we can resume past it.
  let lastEnvelopeSeq = 0;
  const live = subscribeConversationLive({
    connection: natsClient,
    accountId: account.account.accountId,
    agentId: agent.agentId,
    conversationKey: publicConversationKey,
  });
  for await (const message of live) {
    const event = JSON.parse(decoder.decode(message.data)) as NatsStreamEvent;
    lastEnvelopeSeq = event.sequence;
    renderEvent(event);
    if (event.sequence >= 5) {
      console.log(`\n\n[Disconnect] dropping the socket after ${lastEnvelopeSeq} events (agent keeps streaming)`);
      break;
    }
  }
  live.unsubscribe();
  await natsClient.close();

  // Phase 2 — RECONNECT mid-stream and RESUME from JetStream. A reconnecting
  // client opens a NEW connection. We resume past what we already saw and read
  // through to `done`. (Production clients pass startSequence/startTime; here we
  // read from the start and skip the already-seen prefix for simplicity.)
  console.log(`\n[Reconnect] resuming from event ${lastEnvelopeSeq + 1}...`);
  await new Promise((r) => setTimeout(r, 2000)); // Add delay for reconnection
  const reconnectClient = await connectNats({ servers: natsUrl, token: natsToken });
  const resume = await readConversationStream({
    connection: reconnectClient,
    accountId: account.account.accountId,
    agentId: agent.agentId,
    conversationKey: publicConversationKey,
  });
  for await (const message of resume) {
    const event = JSON.parse(decoder.decode(message.data)) as NatsStreamEvent;
    if (event.sequence <= lastEnvelopeSeq) continue; // skip what we saw before the drop
    renderEvent(event);
    if (event.data.type === "done" || event.data.type === "error") {
      console.log(`\n\n[Stream completed with: ${event.data.type}]`);
      break;
    }
  }
  await resume.close();

  // Phase 3 — once the turn is persisted, the SERVER purges the conversation from
  // JetStream (the result lives in the conversation DB now). Confirm the buffer
  // drains to 0; a later reconnect would read the finished turn from the DB.
  let buffered = -1;
  for (let i = 0; i < 10 && buffered !== 0; i++) {
    buffered = await conversationBufferedCount({
      connection: reconnectClient,
      accountId: account.account.accountId,
      agentId: agent.agentId,
      conversationKey: publicConversationKey,
    });
    if (buffered !== 0) await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`[Server purged] buffered messages now: ${buffered} (0 = purged after persist)`);
  await reconnectClient.drain();
} finally {
  await natsClient.drain().catch(() => {});
  await deleteAccount(account.secret);
  console.log("\nDeleted test account");
}
