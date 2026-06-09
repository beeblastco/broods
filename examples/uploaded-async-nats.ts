/**
 * Example uploaded async tool flow via NATS WebSocket stream.
 * Demonstrates the detached Kubernetes runner path for non-SSE requests.
 */

import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { StringCodec } from "nats.ws";
import { toRuntimeAgentConfig, type AgentConfig } from "../functions/_shared/storage/index.ts";
import { connectNats, streamResponseSubject, type NatsStreamEvent } from "../functions/_shared/nats.ts";
import { scopedDirectConversationKey, scopedDirectEventId } from "../functions/_shared/runtime-keys.ts";
import type { DirectInboundEvent } from "../functions/harness-processing/integrations.ts";
import { createAccount, createAgent, createTool, deleteAccount } from "./utils.ts";

const minimaxApiKey = process.env.ACCOUNT_MINIMAX_API_KEY!;
const lambdaFunctionName = process.env.HARNESS_FUNCTION_ARN!;
const natsUrl = process.env.NATS_URL!;
const natsToken = process.env.NATS_TOKEN || undefined;
const connectionId = `ws-uploaded-async-${Date.now()}`;
const publicEventId = `uploaded-async-${Date.now()}`;
const publicConversationKey = `uploaded-async-${Date.now()}`;
const codec = StringCodec();

const natsClient = await connectNats({ servers: natsUrl, token: natsToken });
const lambda = new LambdaClient({ region: "eu-central-1", profile: "default" });
const account = await createAccount(`uploaded-async-${Date.now()}`);
const customTool = await createTool(account.secret, {
  name: "test_uploaded_async",
  description: "Runs a test uploaded async tool.",
  inputSchema: {
    type: "object",
    properties: {
      message: { type: "string" },
    },
    required: ["message"],
    additionalProperties: false,
  },
  defaultConfig: {},
  bundle: `
export default {
  name: "test_uploaded_async",
  async execute(ctx, input) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    return { type: "text", value: \`uploaded async completed: \${input.message}\` };
  },
};
`,
});

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
    system: "You are a helpful assistant. When asked, call the test_uploaded_async tool with the user's message and report the result after it completes.",
  },
  tools: {
    [customTool.toolId]: {
      enabled: true,
      async: true,
    },
  },
}

const agent = await createAgent(account.secret, "External async tool test assistant", agentConfig);

// Subjects are conversation-scoped (durable JetStream); a live core subscription
// still sees publishes in real time. connectionId is now only a routing label.
const subject = streamResponseSubject(account.account.accountId, agent.agentId, publicConversationKey);
const subscription = natsClient.subscribe(subject);

console.log("Created test account:", JSON.stringify(account.account));
console.log("Uploaded test tool:", JSON.stringify(customTool));
console.log("Created test agent:", JSON.stringify(agent));
console.log("Subscribed to:", subject);

try {
  const inboundEvent: DirectInboundEvent = {
    accountId: account.account.accountId,
    agentId: agent.agentId,
    agentConfig: toRuntimeAgentConfig(agentConfig),
    eventId: scopedDirectEventId(account.account.accountId, agent.agentId, publicEventId),
    publicEventId,
    conversationKey: scopedDirectConversationKey(account.account.accountId, agent.agentId, publicConversationKey),
    publicConversationKey,
    connectionId,
    events: [{
      role: "user",
      content: [{ type: "text", text: "Call the uploaded async tool with the message 'world' and tell me the result." }],
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
  await deleteAccount(account.secret);
  console.log("\nDeleted test account");
}
