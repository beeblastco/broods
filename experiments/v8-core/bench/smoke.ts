/** One plain text turn on each runtime, real model, to prove both serve runs. */

import {
  accountClient,
  createAccount,
  haikuModel,
  runtimeClient,
  stackState,
  type Runtime,
} from "./lib.ts";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error("set ANTHROPIC_API_KEY");
const state = stackState();
const runId = Date.now().toString(36);
const secret = await createAccount(state, `smoke-${runId}`);
const agent = await accountClient(state, secret).createAgent({
  name: `smoke-${runId}`,
  config: {
    ...haikuModel(apiKey),
    agent: { system: "Reply in one short sentence." },
  },
});
for (const runtime of ["bun", "workerd"] as Runtime[]) {
  const started = performance.now();
  let text = "";
  let first = 0;
  for await (const part of runtimeClient(runtime, secret)
    .agent("smoke", agent.agentId)
    .stream({
      conversationKey: `smoke-${runtime}-${runId}`,
      input: "Name one planet.",
    })) {
    if (part.type === "text-delta") {
      first ||= performance.now() - started;
      text += part.text;
    }
    if (part.type === "error")
      console.log(runtime, "error part", JSON.stringify(part).slice(0, 300));
  }
  console.log(
    runtime,
    `${(performance.now() - started).toFixed(0)} ms total, first text ${first.toFixed(0)} ms:`,
    JSON.stringify(text),
  );
}
