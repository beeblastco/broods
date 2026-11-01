import { BroodsClient, signUserToken } from "broods";
import { api } from "./broods/_generated/api";

// These agents need a signed user token; your backend signs one per signed-in user.
const client = new BroodsClient({
  userToken: () => signUserToken({ userId: "demo-user" }),
});

for await (const chunk of client.stream(api.agents.hookedAgent, {
  input: "In two sentence, what is a beehive?",
})) {
  switch (chunk.type) {
    case "text-delta":
      process.stdout.write(`\x1b[32m${chunk.text}\x1b[0m`);
      break;
    case "finish":
      process.stdout.write(
        `\n\x1b[37m[Finished: ${chunk.finishReason}]\x1b[0m\n`,
      );
      break;
  }
}
