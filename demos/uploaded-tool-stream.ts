/**
 * Example: streaming an uploaded custom tool on the sync SSE path.
 * Uploads a tool whose `execute` is an async generator, then watches the
 * preliminary tool-result chunks arrive live over SSE before the final result.
 * The detached/async path is covered by uploaded-async-nats.ts instead.
 */

import { createAccount, createAgent, createTool, deleteAccount, streamSSE } from "./utils.ts";

const minimaxApiKey = process.env.ACCOUNT_MINIMAX_API_KEY!;

const username = `uploaded-stream-${Date.now()}`;

// A streaming tool: `execute` is an async *generator*. Each `yield` is surfaced by
// the AI SDK as a preliminary tool-result; the last yield is repeated as the final
// output. A non-generator `execute` (plain return) would simply emit one result.
const account = await createAccount(username);
const customTool = await createTool(account.secret, {
  name: "stream_progress",
  description: "Counts to `steps`, streaming one progress update per step before the final summary.",
  inputSchema: {
    type: "object",
    properties: {
      steps: { type: "number", description: "How many progress updates to stream." },
    },
    required: ["steps"],
    additionalProperties: false,
  },
  defaultConfig: {},
  bundle: `
export default {
  name: "stream_progress",
  async *execute(ctx, input) {
    const steps = Math.max(1, Math.min(10, input.steps ?? 5));
    for (let i = 1; i <= steps; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      yield { type: "text", value: \`progress \${i}/\${steps}\` };
    }
    // The last yield is also the final tool output the model reads.
    yield { type: "text", value: \`done: counted to \${steps}\` };
  },
};
`,
});

const agent = await createAgent(account.secret, "Streaming uploaded tool assistant", {
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
    system:
      "You are a helpful assistant. When asked, call the stream_progress tool and then report its final result.",
  },
  tools: {
    // Sync (foreground) streaming: NOT `async: true`. The detached path would
    // report via callback and would not stream preliminary chunks.
    [customTool.toolId]: {
      enabled: true,
    },
  },
});

console.log("Created test account:", account.account.accountId);
console.log("Uploaded streaming tool:", customTool.toolId);
console.log("Created test agent:", agent.agentId);
console.log("\n--- SSE stream (watch for preliminary tool-result chunks) ---\n");

try {
  const body = {
    agentId: agent.agentId,
    eventId: `test-${Date.now()}`,
    conversationKey: `test-${Date.now()}`,
    events: [
      {
        role: "user",
        content: [{ type: "text", text: "Call the stream_progress tool with steps=5 and tell me the final result." }],
      },
    ],
  };

  for await (const chunk of streamSSE(body, account.secret)) {
    process.stdout.write(chunk + "\n\n");
  }
} finally {
  await deleteAccount(account.secret);
  console.log("\nDeleted test account");
}
