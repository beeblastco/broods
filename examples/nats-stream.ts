/**
 * Example end-to-end NATS WebSocket stream invocation.
 */

import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { connect, StringCodec } from "nats";
import { toRuntimeAccountConfig, type AccountConfig } from "../functions/_shared/accounts.ts";
import { streamResponseSubject, type NatsStreamEvent } from "../functions/_shared/nats.ts";
import { scopedDirectConversationKey, scopedDirectEventId } from "../functions/_shared/runtime-keys.ts";
import type { DirectInboundEvent } from "../functions/harness-processing/integrations.ts";
import { createAccount, createAgent, deleteAccount } from "./utils.ts";

const googleApiKey = process.env.ACCOUNT_GOOGLE_API_KEY!;
const lambdaFunctionName = process.env.LAMBDA_FUNCTION_NAME!;
const natsUrl = process.env.NATS_URL!;
const connectionId = `ws-test-${Date.now()}`;
const publicEventId = `nats-${Date.now()}`;
const publicConversationKey = `nats-${Date.now()}`;
const codec = StringCodec();

if (!googleApiKey) {
  throw new Error("ACCOUNT_GOOGLE_API_KEY is required");
}

const agentConfig: AccountConfig = {
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
    system: "You are a helpful assistant. Keep answers short.",
  },
};

// Intialize client
const nats = await connect({ servers: natsUrl, timeout: 5000 });
const lambda = new LambdaClient({ region: "eu-central-1", profile: "default" });

// Create account and agent, subscribe to the stream before run invoke
const account = await createAccount(`nats-stream-${Date.now()}`);
const agent = await createAgent(account.accountSecret, "NATS stream test assistant", agentConfig);
const subject = streamResponseSubject(account.account.accountId, agent.agent.agentId, connectionId);
const subscription = nats.subscribe(subject);

console.log("Created test account:", JSON.stringify(account.account));
console.log("Created test agent:", JSON.stringify(agent.agent));
console.log("Subscribed to:", subject);

try {
  const inboundEvent: DirectInboundEvent = {
    accountId: account.account.accountId,
    agentId: agent.agent.agentId,
    accountConfig: toRuntimeAccountConfig(agentConfig),
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
            text: "What can you do?",
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

  console.log("Invoked nats-worker. Streaming response:\n");
  await printNatsStream(subscription);
} finally {
  subscription.unsubscribe();
  await nats.drain().catch(() => {});
  await deleteAccount(account.accountSecret);
  console.log("\nDeleted test account");
}

async function printNatsStream(subscription: ReturnType<typeof nats.subscribe>): Promise<void> {
  const timeout = setTimeout(() => {subscription.unsubscribe();}, 120000);

  try {
    for await (const message of subscription) {
      const event = JSON.parse(codec.decode(message.data)) as NatsStreamEvent;
      const data = event.data as { type?: string; text?: string; error?: string };

      process.stdout.write(`\n[${event.sequence}] ${JSON.stringify(data)}\n`);
      
      if (data.type === "finish" || data.type === "error") {
        break;
      }
    }
  } finally {
    clearTimeout(timeout);
  }
}
