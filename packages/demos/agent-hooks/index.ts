/**
 * Example: a user code hook that runs in the V8 isolate at `agent.started` and
 * injects a system instruction before the model is called.
 */

import { BroodsClient } from "broods";
import { api } from "./broods/_generated/api";

const client = new BroodsClient();

for await (const chunk of client.stream(api.agents.hookedAgent, {
  input: "In two sentence, what is a beehive?",
})) {
  switch (chunk.type) {
    case "text-delta":
      process.stdout.write(`\x1b[32m${chunk.text}\x1b[0m`);
      break;
    case "finish":
      process.stdout.write(`\n\x1b[37m[Finished: ${chunk.finishReason}]\x1b[0m\n`);
      break;
  }
}
