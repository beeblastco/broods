/**
 * Example: stream a deployed endpoint over WebSocket.
 */

import { WebsocketClient } from "filthy-panty";
import { api } from "./filthypanty/_generated/api";

const endpointId = api.agents.chat.endpointId;
if (!endpointId) {
  throw new Error("WebSocket demo requires generated endpoint metadata. Run `bun run dev` or `bun run deploy` first.");
}

const client = new WebsocketClient({
  host: process.env.FILTHY_PANTY_HOST,
  apiKey: process.env.FILTHY_PANTY_API_KEY!,
});

for await (const message of client.stream({
  endpointId,
  projectSlug: api.agents.chat.projectSlug,
  environmentSlug: api.agents.chat.environmentSlug,
  sessionId: "websocket-demo",
  message: "Reply with one sentence confirming this websocket demo is connected.",
})) {
  switch (message.type) {
    case "meta":
      console.log(`session=${message.sessionId} task=${message.taskId}`);
      break;
    case "sse":
      process.stdout.write(message.chunk);
      break;
    case "continuation_delta":
      process.stdout.write(message.delta);
      break;
    case "subagent_delta":
      process.stdout.write(message.delta);
      break;
    case "subagent_activity":
      console.log(`\n[subagent ${message.phase}]`);
      break;
    case "subagent_result":
      console.log(`\n[subagent result] ${message.output}`);
      break;
    case "done":
      process.stdout.write("\n");
      break;
    case "error":
      throw new Error(message.error);
  }
}
