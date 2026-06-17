/**
 * Example: stream a deployed endpoint over WebSocket.
 */

import { WebsocketClient } from "filthy-panty";
import { api } from "./filthypanty/_generated/api";

const client = new WebsocketClient({
  host: process.env.FILTHY_PANTY_HOST!,
  apiKey: process.env.FILTHY_PANTY_API_KEY!,
});

for await (const message of client.stream({
  endpointId: api.agents.chat.endpointId,
  projectSlug: api.agents.chat.projectSlug,
  environmentSlug: api.agents.chat.environmentSlug,
  sessionId: "websocket-demo",
  events: [{
    role: "user",
    content: [{ type: "text", text: "Generate a short story about two unlikely friends." }],
  }],
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
