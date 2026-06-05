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
import { connectNats, readConversationStream, subscribeConversationLive, type NatsStreamEvent } from "../functions/_shared/nats.ts";
import { scopedDirectConversationKey, scopedDirectEventId } from "../functions/_shared/runtime-keys.ts";
import type { DirectInboundEvent } from "../functions/harness-processing/integrations.ts";
import { createAccount, createAgent, deleteAccount } from "./utils.ts";

const googleApiKey = process.env.ACCOUNT_GOOGLE_API_KEY!;
const tavilyApiKey = process.env.ACCOUNT_TAVILY_API_KEY!;
const lambdaFunctionName = process.env.HARNESS_FUNCTION_ARN!;
const natsUrl = process.env.NATS_URL!;
const natsToken = process.env.NATS_TOKEN || undefined;
const connectionId = `ws-test-${Date.now()}`;
const publicEventId = `nats-${Date.now()}`;
const publicConversationKey = `nats-${Date.now()}`;
const decoder = new TextDecoder();

const researchAgentConfig: AgentConfig = {
  provider: {
    google: {
      apiKey: googleApiKey,
    },
  },
  model: {
    provider: "google",
    modelId: "gemma-4-31b-it",
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
    google: {
      apiKey: googleApiKey,
    },
  },
  model: {
    provider: "google",
    modelId: "gemma-4-31b-it",
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

  // Phase 1 — LIVE via core subscribe (lowest latency). A connected client reads
  // here; core Msgs carry the envelope but not the JetStream seq, so track the
  // envelope `sequence` as the cursor.
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
    process.stdout.write(`\n[live ${event.sequence}] ${JSON.stringify(event.data)}\n`);
    if (event.data.type === "done" || event.data.type === "error") {
      console.log(`\n[Stream completed with: ${event.data.type}]`);
      break;
    }
  }
  live.unsubscribe();

  // Phase 2 — REPLAY via JetStream (a "reconnect"). Proves the stream persisted
  // everything even though Phase 1 read it live. A real client resuming after a
  // drop would pass startSequence (last JsMsg.seq) or startTime instead of
  // replaying from the start, and dedupe by the envelope sequence at the seam.
  console.log(`\n[Reconnect] replaying ${lastEnvelopeSeq} persisted events...`);
  const replay = await readConversationStream({
    connection: natsClient,
    accountId: account.account.accountId,
    agentId: agent.agentId,
    conversationKey: publicConversationKey,
  });
  for await (const message of replay) {
    const event = JSON.parse(decoder.decode(message.data)) as NatsStreamEvent;
    process.stdout.write(`  replay [seq ${message.seq}] ${String(event.data.type)}\n`);
    if (event.sequence >= lastEnvelopeSeq) {
      break;
    }
  }
  await replay.close();
} finally {
  await natsClient.drain().catch(() => {});
  await deleteAccount(account.secret);
  console.log("\nDeleted test account");
}
