// Bytes core puts before the model, pinned with no slack in agent-context-budget.json.
// CI fails a PR that raises one unless it carries the agent-context-increase label.

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

process.env.FILESYSTEM_BUCKET_NAME = "filesystem";
process.env.SKILLS_BUCKET_NAME = "skills";
// The environment block names the weekday, so a fixed clock keeps its length.
setSystemTime(new Date("2026-01-07T12:00:00.000Z"));
afterAll(() => setSystemTime());

await mock.module("../src/shared/s3.ts", () => ({
  ...actualS3,
  readS3Text: async (): Promise<string> => {
    throw Object.assign(new Error("not found"), { name: "NoSuchKey" });
  },
  readS3TextHead: async (): Promise<string> =>
    "---\nname: release-notes\ndescription: Drafts release notes from merged changes.\n---\n",
}));

const sandboxes: Record<string, SandboxConfigRecord> = {
  sb_starter: sandboxRecord("sb_starter", "lambda-sandbox", {
    provider: "lambda",
    network: { mode: "deny-all" },
    permissionMode: "bypass",
    timeout: 60,
  }),
  // Reserved + Obscura on allow-all: bash background jobs, async_status and browse register.
  sb_browser: sandboxRecord("sb_browser", "browser", {
    provider: "lambda",
    image: "obscura",
    network: { mode: "allow-all" },
    persistent: true,
  }),
  // A machine, so `computer` registers.
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

const unused = (): Promise<never> =>
  Promise.reject(new Error("the budget only registers tools"));

it("agent context matches the committed budget", async () => {
  // The `broods init` agent on a direct API turn: what core adds to every ordinary turn.
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
  // Every built-in prompt block and tool on, on a channel turn: the most core can add.
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
      compactionPromptBytes: utf8Bytes(DEFAULT_COMPACTION_PROMPT),
    },
    "Set agent-context-budget.json to the measured values.",
  ).toEqual(budget);
});

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
  // What the provider receives per tool; output schemas and approval stay inside core.
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
