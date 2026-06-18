/**
 * Example: stream a deployed endpoint over WebSocket.
 */

import { WebsocketClient } from "filthy-panty";
import { api } from "./filthypanty/_generated/api";

const client = new WebsocketClient();

for await (const message of client.stream({
  agent: api.agents.chat,
  sessionId: "websocket-demo",
  events: [{
    role: "user",
    content: [{ 
      type: "text", 
      text: "Generate a short story about two unlikely friends." 
    }],
  }],
})) {
  switch (message.type) {
    case "meta":
      console.log(`session=${message.sessionId} task=${message.taskId}`);
      break;
    case "text-delta":
      if (typeof message.text === "string") {
        process.stdout.write(message.text);
      }
      break;
    case "done":
      process.stdout.write("\nFinished\n");
      break;
    case "error":
      throw new Error(typeof message.error === "string" ? message.error : JSON.stringify(message.error));
    default:
      console.log(JSON.stringify(message));
  }
}
