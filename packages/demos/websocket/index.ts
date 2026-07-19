/**
 * Example: stream a deployed endpoint and steer its active WebSocket run.
 */

import { WebsocketClient } from "broods";
import { api } from "./broods/_generated/api";

const client = new WebsocketClient();
const sessionId = `websocket-steer-${crypto.randomUUID()}`;
let subscription!: ReturnType<typeof client.subscribe>;
let steerSent = false;

await new Promise<void>((resolve, reject) => {
  subscription = client.subscribe(
    {
      agent: api.agents.chat,
      sessionId: sessionId,
      eventId: "story-1",
      input: "Draft a short story about two unlikely friends.",
    },
    {
      onMeta(meta) {
        console.log(`session=${meta.sessionId} task=${meta.taskId}`);
        if (steerSent) return;
        steerSent = true;

        // A control request is durably accepted before its ACK. If this run has
        // another model boundary, the prompt steers story-1; otherwise it becomes
        // a FIFO follow-up and the status frame reports appliedMode: "followup".
        subscription.sendControl({
          requestId: "steer-1",
          eventId: "story-2",
          idempotencyKey: `${sessionId}-story-2`,
          mode: "steer",
          input:
            "Make the second friend a maintenance robot, and keep the ending hopeful.",
        });
      },
      onMessage(message) {
        switch (message.type) {
          case "ack":
            console.log(`\naccepted ${message.eventId}: ${message.status}`);
            break;
          case "status":
            console.log(
              `\n${message.eventId}: ${message.status} via ${message.appliedMode ?? "pending"}`,
            );
            break;
          case "text-delta":
            if (typeof message.text === "string")
              process.stdout.write(message.text);
            break;
        }
      },
      onDone() {
        process.stdout.write("\nFinished\n");
        resolve();
      },
      onError(error) {
        reject(error);
      },
    },
  );
});
