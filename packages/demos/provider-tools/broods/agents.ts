import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { defineAgent, defineSandbox, defineWorkspace, env } from "broods";

export const box = defineSandbox({
  name: "provider-tools-box",
  provider: "sandbox",
  permissionMode: "bypass",
  options: { mountAwsS3Buckets: true },
});

export const repo = defineWorkspace({
  name: "repo",
  storage: { provider: "s3" },
});

// Keys are free, as in the AI SDK: the provider tool is found by its id.
// Hosted tools run at Anthropic; bash and the text editor run on `box` as Broods' own tools.
export const claudeAgent = defineAgent({
  name: "claude-provider-tools",
  provider: { anthropic: { apiKey: env("ANTHROPIC_API_KEY") } },
  model: { provider: "anthropic", modelId: "claude-haiku-5-5" },
  tools: {
    webSearch: anthropic.tools.webSearch_20260318({ maxUses: 3 }),
    webFetch: anthropic.tools.webFetch_20260318({}),
    bash: anthropic.tools.bash_20250124({}),
    str_replace_based_edit_tool: anthropic.tools.textEditor_20250728({}),
  },
  sandboxes: [box],
  workspaces: [repo],
  publicAccess: true,
});

// A custom tool's text goes to `command` on stdin; shell and apply_patch run on `box`.
export const gptAgent = defineAgent({
  name: "gpt-provider-tools",
  provider: { openai: { apiKey: env("OPENAI_API_KEY") } },
  model: { provider: "openai", modelId: "gpt-5.5" },
  tools: {
    write_sql: {
      ...openai.tools.customTool({
        description: "Run one SQLite SELECT against data.db.",
        format: {
          type: "grammar",
          syntax: "regex",
          definition: "SELECT [^;]+",
        },
      }),
      command: "sqlite3 -readonly data.db",
    },
    shell: openai.tools.shell({}),
    apply_patch: openai.tools.applyPatch({}),
  },
  sandboxes: [box],
  workspaces: [repo],
  publicAccess: true,
});
