/**
 * Agent context budget: the UTF-8 bytes of the text core itself puts in front
 * of the model, built by the real Session and tool registry the way the
 * harness builds them, and pinned in agent-context-budget.json. The file must
 * equal the measurement, so it holds no slack and a cut forces a lower
 * number; .github/workflows/agent-context-budget.yaml fails a pull request
 * that raises one unless it carries the agent-context-increase label.
 */

import { afterAll, expect, it, mock, setSystemTime } from "bun:test";
import { asSchema } from "ai";
import { normalizeSandboxConfig } from "@broods/convex/model/sandboxRules";
import { normalizeWorkspaceConfig } from "@broods/convex/model/workspaceRules";
import type { SessionOptions } from "../src/harness/session.ts";
import type { ToolContext } from "../src/harness/tools/index.ts";
import { DEFAULT_COMPACTION_PROMPT } from "../src/shared/.generated/compaction-prompt.ts";
import type { AgentConfig } from "../src/shared/domain/agent-config.ts";
import type {
  SandboxConfig,
  SandboxConfigRecord,
} from "../src/shared/domain/sandbox-config.ts";
import type { WorkspaceConfigRecord } from "../src/shared/domain/workspace-config.ts";
import {
  accountAgentScopedKey,
  scopedDirectConversationKey,
  TELEGRAM_INTEGRATION_PREFIX,
} from "../src/shared/runtime-keys.ts";
import * as actualS3 from "../src/shared/s3.ts";
import { setStorageForTests, type Storage } from "../src/shared/storage.ts";
import budget from "./agent-context-budget.json" with { type: "json" };

const ACCOUNT_ID = "acct_budget";
const AGENT_ID = "agent_budget";
const SKILL_PATH = `${ACCOUNT_ID}/release-notes`;
const CREATED_AT = "2026-01-01T00:00:00.000Z";

// Bucket names only shape S3 keys here; nothing is read from AWS.
process.env.FILESYSTEM_BUCKET_NAME = "filesystem";
process.env.SKILLS_BUCKET_NAME = "skills";
// The environment block names the weekday, so a fixed clock keeps its length.
setSystemTime(new Date("2026-01-07T12:00:00.000Z"));
afterAll(() => setSystemTime());

await mock.module("../src/shared/s3.ts", () => ({
  ...actualS3,
  // No memory index yet: what the agent wrote there is not core's text.
  readS3Text: async (): Promise<string> => {
    throw Object.assign(new Error("not found"), { name: "NoSuchKey" });
  },
  readS3TextHead: async (): Promise<string> =>
    "---\nname: release-notes\ndescription: Drafts release notes from merged changes.\n---\n",
}));

// Stored the way the config plane writes them, so defaults match a real row.
const sandboxes: Record<string, SandboxConfigRecord> = {
  // What `broods init` writes.
  sb_starter: sandboxRecord("sb_starter", "lambda-sandbox", {
    provider: "lambda",
    network: { mode: "deny-all" },
    permissionMode: "bypass",
    timeout: 60,
  }),
  // Reserved, so bash offers background jobs and async_status registers;
  // Obscura on allow-all, so browse registers.
  sb_browser: sandboxRecord("sb_browser", "browser", {
    provider: "lambda",
    image: "obscura",
    network: { mode: "allow-all" },
    persistent: true,
  }),
  // A machine, so computer registers.
  sb_laptop: sandboxRecord("sb_laptop", "laptop", {
    provider: "machine",
    network: { mode: "allow-all" },
  }),
};
const workspace: WorkspaceConfigRecord = {
  accountId: ACCOUNT_ID,
  workspaceId: "ws_default",
  name: "default",
  config: normalizeWorkspaceConfig({ storage: { provider: "s3" } }),
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};
setStorageForTests({
  sandboxConfigs: {
    getById: async (_accountId: string, sandboxId: string) =>
      sandboxes[sandboxId] ?? null,
  },
  workspaceConfigs: {
    getById: async (_accountId: string, workspaceId: string) =>
      workspaceId === workspace.workspaceId ? workspace : null,
  },
} as unknown as Storage);

const { Session } = await import("../src/harness/session.ts");
const { createTools } = await import("../src/harness/tools/index.ts");

// Registration only stores tool definitions, so nothing here is ever called.
const unused = (): Promise<never> =>
  Promise.reject(new Error("the budget only registers tools"));

// CI rejects a pull request that raises a value above its base branch's
// agent-context-budget.json, unless it has the agent-context-increase label.
// Lower the values when the text shrinks.
it("agent context matches the committed budget", async () => {
  // The agent `broods init` writes, minus its own system prompt, on a direct
  // API turn: what core adds to every turn of an ordinary agent.
  const starter = await modelContext({
    eventId: "event",
    conversationKey: scopedDirectConversationKey(
      ACCOUNT_ID,
      AGENT_ID,
      "budget",
    ),
    accountId: ACCOUNT_ID,
    agentId: AGENT_ID,
    agentConfig: { sandboxes: ["sb_starter"] },
  });
  // Every built-in prompt block and tool switched on at once, on a channel
  // turn: the most core can add, so growth in any of them shows here.
  const full = await modelContext(
    {
      eventId: "event",
      conversationKey: accountAgentScopedKey(
        ACCOUNT_ID,
        AGENT_ID,
        `${TELEGRAM_INTEGRATION_PREFIX}42`,
      ),
      accountId: ACCOUNT_ID,
      agentId: AGENT_ID,
      agentConfig: {
        sandboxes: ["sb_browser", "sb_laptop"],
        workspaces: [{ name: "default", workspaceId: "ws_default" }],
        browser: { enabled: true },
        scheduler: { enabled: true },
        skills: { enabled: true, allowed: [SKILL_PATH] },
        subagent: { enabled: true },
        channels: { telegram: {} },
      },
      delivery: { kind: "channel", channelName: "telegram", source: {} },
      channelActions: {
        sendText: unused,
        sendFiles: unused,
        sendImages: unused,
        sendSticker: unused,
        sendTyping: unused,
        supportsReactions: true,
        reactToMessage: unused,
      },
    },
    {
      dispatchSessionMessage: unused,
      dispatchSubagents: unused,
      askParent: unused,
    },
  );

  expect(
    {
      starterSystemPromptBytes: starter.systemPromptBytes,
      starterEnvironmentBytes: starter.environmentBytes,
      starterToolListJsonBytes: starter.toolListJsonBytes,
      fullSystemPromptBytes: full.systemPromptBytes,
      fullEnvironmentBytes: full.environmentBytes,
      fullToolListJsonBytes: full.toolListJsonBytes,
      // Sent on each compaction call, not every turn.
      compactionPromptBytes: utf8Bytes(DEFAULT_COMPACTION_PROMPT),
    },
    "Set agent-context-budget.json to the measured values.",
  ).toEqual(budget);
});

/**
 * The bytes one model pass carries from core for this session: the system
 * prompt, the environment block after the history, and the tool list.
 */
async function modelContext(
  options: SessionOptions & { agentConfig: AgentConfig },
  dispatchers: Pick<
    ToolContext,
    "askParent" | "dispatchSessionMessage" | "dispatchSubagents"
  > = {},
): Promise<{
  systemPromptBytes: number;
  environmentBytes: number;
  toolListJsonBytes: number;
}> {
  const session = new Session(options);
  const { system } = await session.createEphemeralTurnContext([
    { role: "user", content: "hello" },
  ]);
  // The context runAgentLoop hands the registry, minus run callbacks that
  // only fire once a tool executes.
  const delivery = session.delivery;
  const tools = await createTools(
    {
      accountId: session.accountId,
      conversationKey: session.conversationKey,
      workspaces: session.resolvedWorkspaces(),
      sandboxes: session.sandboxes(),
      modelProviderName: "anthropic",
      modelProvider: undefined,
      session: session,
      ...dispatchers,
      ...(delivery?.kind === "channel" && session.channelActions
        ? {
            channel: {
              actions: session.channelActions,
              channelName: delivery.channelName,
              transformText: async (text: string): Promise<string> => text,
            },
          }
        : {}),
    },
    options.agentConfig,
  );
  // What the provider receives per tool. Output schemas and approval stay
  // inside core.
  const toolList = await Promise.all(
    Object.entries(tools).map(async ([name, tool]) => ({
      name: name,
      description:
        typeof tool.description === "function"
          ? tool.description({ context: undefined })
          : tool.description,
      inputSchema: await asSchema(tool.inputSchema).jsonSchema,
    })),
  );

  return {
    // Joined the way the trace's `model.system` attribute shows it.
    systemPromptBytes: utf8Bytes(
      system.map((message) => message.content).join("\n\n"),
    ),
    environmentBytes: utf8Bytes(session.environmentText()),
    toolListJsonBytes: utf8Bytes(JSON.stringify(toolList)),
  };
}

function sandboxRecord(
  sandboxId: string,
  name: string,
  config: SandboxConfig,
): SandboxConfigRecord {
  return {
    accountId: ACCOUNT_ID,
    sandboxId: sandboxId,
    name: name,
    config: normalizeSandboxConfig(config),
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
