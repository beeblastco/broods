/**
 * Example NATS WebSocket stream invocation with subagents and tools.
 * Ctr+C to exit when you want to close the connection and exit.
 */

import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { connect, StringCodec } from "nats";
import { toRuntimeAgentConfig, type AgentConfig } from "../functions/_shared/storage/index.ts";
import { streamResponseSubject, type NatsStreamEvent } from "../functions/_shared/nats.ts";
import { scopedDirectConversationKey, scopedDirectEventId } from "../functions/_shared/runtime-keys.ts";
import type { DirectInboundEvent } from "../functions/harness-processing/integrations.ts";
import { createAccount, createAgent, deleteAccount } from "./utils.ts";

const googleApiKey = process.env.ACCOUNT_GOOGLE_API_KEY!;
const tavilyApiKey = process.env.ACCOUNT_TAVILY_API_KEY!;
const lambdaFunctionName = process.env.HARNESS_FUNCTION_ARN!;
const natsUrl = process.env.NATS_URL!;
const connectionId = `ws-test-${Date.now()}`;
const publicEventId = `nats-${Date.now()}`;
const publicConversationKey = `nats-${Date.now()}`;
const codec = StringCodec();

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

const natsClient = await connect({ servers: natsUrl, timeout: 5000 });
const lambda = new LambdaClient({ region: "eu-central-1", profile: "default" });

const account = await createAccount(`nats-stream-${Date.now()}`);
const researchAgent = await createAgent(
  account.accountSecret,
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
    allowed: [researchAgent.agent.agentId],
    context: "new",
  },
};
const agent = await createAgent(account.accountSecret, "NATS stream test assistant", agentConfig);

const subject = streamResponseSubject(account.account.accountId, agent.agent.agentId, connectionId);
const subscription = natsClient.subscribe(subject);

console.log("Created test account:", JSON.stringify(account.account));
console.log("Created research subagent:", JSON.stringify(researchAgent.agent));
console.log("Created test agent:", JSON.stringify(agent.agent));
console.log("Subscribed to:", subject);

try {
  const inboundEvent: DirectInboundEvent = {
    accountId: account.account.accountId,
    agentId: agent.agent.agentId,
    agentConfig: toRuntimeAgentConfig(agentConfig),
    eventId: scopedDirectEventId(account.account.accountId, agent.agent.agentId, publicEventId),
    publicEventId: publicEventId,
    conversationKey: scopedDirectConversationKey(account.account.accountId, agent.agent.agentId, publicConversationKey),
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

  for await (const message of subscription) {
    const event = JSON.parse(codec.decode(message.data)) as NatsStreamEvent;
    process.stdout.write(`\n[${event.sequence}] ${JSON.stringify(event.data)}\n`);
    if (event.data.type === "done" || event.data.type === "error") {
      console.log(`\n[Stream completed with: ${event.data.type}]`);
      break;
    }
  }
} finally {
  subscription.unsubscribe();
  await natsClient.drain().catch(() => {});
  await deleteAccount(account.accountSecret);
  console.log("\nDeleted test account");
}
