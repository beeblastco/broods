import { defineAgent, defineMcp, defineSandbox, env } from "broods";

// One persistent VM on the Obscura image: `browse` and the Obscura MCP server
// both run here, so the MCP server's browser session lasts between calls.
export const web = defineSandbox({
  name: "obscura-web",
  provider: "lambda",
  image: "obscura",
  persistent: true,
  network: { mode: "allow-all" },
  permissionMode: "bypass",
  timeout: 120,
});

// Obscura's own MCP server, spawned inside the VM on first use.
export const obscura = defineMcp({
  name: "obscura",
  description: "Headless browser tools: navigate, click, fill, screenshot.",
  sandbox: web,
  command: ["obscura", "mcp"],
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
      "You read the web for the user. Use the browse tool to read a page, and the obscura tools when you need to act on a page. Answer in one short paragraph.",
  },
  sandboxes: [web],
  browser: { enabled: true },
  mcp: { [obscura.name]: { enabled: true } },
  publicAccess: true,
});
