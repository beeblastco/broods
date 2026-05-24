/**
 * Example external-dispatch async tool flow via NATS WebSocket stream.
 * Demonstrates how tools can dispatch work to an external service and
 * receive results via webhook callback.
 */

import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { connect, StringCodec } from "nats";
import { toRuntimeAgentConfig, type AgentConfig } from "../functions/_shared/storage/index.ts";
import { streamResponseSubject, type NatsStreamEvent } from "../functions/_shared/nats.ts";
import { scopedDirectConversationKey, scopedDirectEventId } from "../functions/_shared/runtime-keys.ts";
import type { DirectInboundEvent } from "../functions/harness-processing/integrations.ts";
import { AGENT_SERVICE_URL, createAccount, createAgent, deleteAccount } from "./utils.ts";

const googleApiKey = process.env.ACCOUNT_GOOGLE_API_KEY!;
const lambdaFunctionName = process.env.HARNESS_FUNCTION_ARN!;
const natsUrl = process.env.NATS_URL!;
const connectionId = `ws-external-async-${Date.now()}`;
const publicEventId = `external-async-${Date.now()}`;
const publicConversationKey = `external-async-${Date.now()}`;
const codec = StringCodec();

const natsClient = await connect({ servers: natsUrl, timeout: 5000 });
const lambda = new LambdaClient({ region: "eu-central-1", profile: "default" });
const account = await createAccount(`external-async-${Date.now()}`);

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
    system: "You are a helpful assistant. When asked, call the test_external_async tool with the user's message and report the result after it completes.",
  },
  tools: {
    test_external_async: {
      enabled: true,
      async: true,
      execution: "external-dispatch", // Using 'external-dispatch' mode
      completionBaseUrl: AGENT_SERVICE_URL,
      completionBearerToken: account.accountSecret,
    },
  },
}

const agent = await createAgent(account.accountSecret, "External async tool test assistant", agentConfig);

const subject = streamResponseSubject(account.account.accountId, agent.agent.agentId, connectionId);
const subscription = natsClient.subscribe(subject);

console.log("Created test account:", JSON.stringify(account.account));
console.log("Created test agent:", JSON.stringify(agent.agent));
console.log("Subscribed to:", subject);

try {
  const inboundEvent: DirectInboundEvent = {
    accountId: account.account.accountId,
    agentId: agent.agent.agentId,
    agentConfig: toRuntimeAgentConfig(agentConfig),
    eventId: scopedDirectEventId(account.account.accountId, agent.agent.agentId, publicEventId),
    publicEventId,
    conversationKey: scopedDirectConversationKey(account.account.accountId, agent.agent.agentId, publicConversationKey),
    publicConversationKey,
    connectionId,
    events: [{
      role: "user",
      content: [{ type: "text", text: "Call the external async tool with the message 'world' and tell me the result." }],
    }],
  };

  await lambda.send(new InvokeCommand({
    FunctionName: lambdaFunctionName,
    InvocationType: "Event",
    Payload: new TextEncoder().encode(JSON.stringify({ kind: "nats-worker", event: inboundEvent })),
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
