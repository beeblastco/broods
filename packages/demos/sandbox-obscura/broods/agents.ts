import { defineAgent, defineSandbox, env } from "broods";

// One persistent VM on the Obscura image. `browse` runs a fresh `obscura fetch`
// there for each call, so no page state carries between calls.
export const web = defineSandbox({
  name: "obscura-web",
  provider: "lambda",
  image: "obscura",
  persistent: true,
  network: { mode: "allow-all" },
  permissionMode: "bypass",
  timeout: 120,
});

export const browser = defineAgent({
  name: "browser",
  provider: {
    deepseek: { apiKey: env("DEEPSEEK_API_KEY") },
  },
  model: {
    provider: "deepseek",
    modelId: "deepseek-flash",
  },
  agent: {
    system:
      "You read the web for the user with the browse tool. Answer in one short paragraph.",
  },
  sandboxes: [web],
  browser: { enabled: true },
  publicAccess: true,
});
