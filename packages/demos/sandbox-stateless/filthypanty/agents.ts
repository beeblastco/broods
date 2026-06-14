import { defineAgent, defineSandbox, env } from "filthy-panty";

// A stateless, bash-only sandbox, fresh ephemeral container per call.
export const statelessSandbox = defineSandbox("stateless-sandbox", {
  provider: "lambda",
  network: { mode: "deny-all" },
  permissionMode: "bypass",
  timeout: 60,
});

export const myAgent = defineAgent("my-agent", {
  provider: {
    minimax: { apiKey: env("ACCOUNT_MINIMAX_API_KEY") },
  },
  model: {
    provider: "minimax",
    modelId: "MiniMax-M3",
  },
  agent: {
    system: [
      "You only have the bash tool — there is no persistent workspace.",
      "Each bash call is a fresh container, so write any files and run them in the SAME command.",
      "Report stdout and status for every run.",
    ].join("\n"),
  },
  sandbox: statelessSandbox,
});
