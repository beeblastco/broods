import { describe, expect, it } from "bun:test";
import { policyInputForTool } from "../src/harness/policy.ts";
import type { ResolvedWorkspace } from "../src/shared/workspaces.ts";

const workspaces: ResolvedWorkspace[] = [
  {
    name: "repo",
    workspaceId: "ws_123",
    namespace: "repo-ns",
    config: { storage: { provider: "s3" } },
    sandbox: {
      provider: "lambda",
      permissionMode: "ask",
    },
  },
];

describe("agent policy input", () => {
  it("maps filesystem tool calls to workspace actions and trusted workspace context", () => {
    expect(
      policyInputForTool(
        "read",
        { workspace: "repo", file_path: "src/index.ts" },
        workspaces,
      ),
    ).toEqual({
      action: "workspace.read",
      toolName: "read",
      tool: {
        input: { workspace: "repo", file_path: "src/index.ts" },
        inputKeys: ["file_path", "workspace"],
        inputPreview: 'workspace="repo" file_path="src/index.ts"',
      },
      workspaceId: "ws_123",
      workspaceName: "repo",
      sandboxPermissionMode: "ask",
      filePath: "src/index.ts",
    });

    expect(
      policyInputForTool(
        "bash",
        { workspace: "repo", command: "bun test" },
        workspaces,
      ),
    ).toMatchObject({
      action: "workspace.exec",
      toolName: "bash",
      tool: {
        input: { workspace: "repo", command: "bun test" },
        inputKeys: ["command", "workspace"],
        inputPreview: 'workspace="repo" command="bun test"',
      },
      workspaceId: "ws_123",
      workspaceName: "repo",
    });

    // A `filePaths` prefix rule must see the path the tool resolves, not the model's spelling.
    expect(
      policyInputForTool(
        "write",
        { workspace: "repo", file_path: "./secrets/key" },
        workspaces,
      ).filePath,
    ).toBe("secrets/key");
    expect(
      policyInputForTool(
        "write",
        { workspace: "repo", file_path: "./secrets/a..b" },
        workspaces,
      ).filePath,
    ).toBe("secrets/a..b");
    expect(
      policyInputForTool(
        "read",
        { workspace: "repo", file_path: "../etc/passwd" },
        workspaces,
      ).filePath,
    ).toBe("../etc/passwd");
    // A search root ends in `/`, so `secrets/` covers the directory but not `secrets-public`.
    for (const [toolName, path, filePath] of [
      ["grep", "secrets", "secrets/"],
      ["grep", "/secrets", "secrets/"],
      ["glob", "secrets/", "secrets/"],
      ["glob", "secrets-public", "secrets-public/"],
      ["grep", ".", ""],
      ["glob", undefined, ""],
    ] as const) {
      expect(
        policyInputForTool(
          toolName,
          { workspace: "repo", pattern: "API_KEY", path: path },
          workspaces,
        ),
      ).toMatchObject({ filePath: filePath, searchRoot: true });
    }

    expect(
      policyInputForTool(
        "memory_save",
        {
          workspace: "repo",
          title: "Owner prefers short replies",
          description: "d",
          content: "c",
        },
        workspaces,
      ),
    ).toMatchObject({
      action: "workspace.write",
      toolName: "memory_save",
      workspaceId: "ws_123",
      workspaceName: "repo",
      filePath: "memory/owner-prefers-short-replies.md",
    });
  });

  it("maps skill and subagent references", () => {
    expect(
      policyInputForTool(
        "load_skill",
        { path: "acct/skills/review/SKILL.md" },
        [],
      ),
    ).toEqual({
      action: "skill.load",
      toolName: "load_skill",
      tool: {
        input: { path: "acct/skills/review/SKILL.md" },
        inputKeys: ["path"],
        inputPreview: 'path="acct/skills/review/SKILL.md"',
      },
      skillPath: "acct/skills/review/SKILL.md",
    });

    expect(
      policyInputForTool(
        "run_subagent",
        { tasks: [{ agentId: "agent_child", prompt: "check this" }] },
        [],
      ),
    ).toEqual({
      action: "subagent.run",
      toolName: "run_subagent",
      tool: {
        input: { tasks: [{ agentId: "agent_child", prompt: "check this" }] },
        inputKeys: ["tasks"],
        inputPreview: "tasks=[array:1]",
      },
      subagentId: "agent_child",
    });
  });

  // An extra sandbox mounts no workspace, so a workspace-scoped rule must not be handed one.
  it("describes a bash call on an extra sandbox by that sandbox, not a workspace", () => {
    const sandboxes = [
      {
        name: "own-sandbox",
        sandbox: {
          provider: "lambda" as const,
          permissionMode: "ask" as const,
        },
      },
      {
        name: "browser-sandbox",
        sandbox: {
          provider: "lambda" as const,
          permissionMode: "bypass" as const,
        },
      },
    ];
    const onExtra = policyInputForTool(
      "bash",
      { command: "chromium --version", sandbox: "browser-sandbox" },
      workspaces,
      { sandboxes: sandboxes },
    );

    expect(onExtra.action).toBe("workspace.exec");
    expect(onExtra.workspaceId).toBeUndefined();
    expect(onExtra.workspaceName).toBeUndefined();
    expect(onExtra.sandboxPermissionMode).toBe("bypass");

    const unknown = policyInputForTool(
      "bash",
      { command: "ls", sandbox: "nope" },
      workspaces,
      { sandboxes: sandboxes },
    );
    expect(unknown.workspaceId).toBe("ws_123");
    const withoutSandboxes = policyInputForTool(
      "bash",
      { command: "ls", sandbox: "browser-sandbox" },
      workspaces,
    );
    expect(withoutSandboxes.workspaceId).toBe("ws_123");

    // An unnamed call runs on the default sandbox, so it must see the same mode as a named one.
    const unnamed = policyInputForTool("bash", { command: "ls" }, [], {
      sandboxes: sandboxes,
    });
    const named = policyInputForTool(
      "bash",
      { command: "ls", sandbox: "own-sandbox" },
      [],
      { sandboxes: sandboxes },
    );
    expect(unnamed.sandboxPermissionMode).toBe("ask");
    expect(unnamed.sandboxPermissionMode).toBe(named.sandboxPermissionMode);
  });

  it("defaults unknown tools to generic tool calls", () => {
    expect(policyInputForTool("googleSearch", { query: "opa" }, [])).toEqual({
      action: "tool.call",
      toolName: "googleSearch",
      tool: {
        input: { query: "opa" },
        inputKeys: ["query"],
        inputPreview: 'query="opa"',
      },
    });
  });

  it("maps MCP tool model names to their server row ids when provided", () => {
    expect(
      policyInputForTool(
        "crm__customer_lookup",
        { email: "a@example.com" },
        [],
        {
          mcpIdsByName: new Map([
            ["crm__customer_lookup", "qs78zwc4z4q5ysxm74fgrhd13s88xxt"],
          ]),
        },
      ),
    ).toEqual({
      action: "tool.call",
      toolName: "crm__customer_lookup",
      mcpId: "qs78zwc4z4q5ysxm74fgrhd13s88xxt",
      tool: {
        input: { email: "a@example.com" },
        inputKeys: ["email"],
        inputPreview: 'email="a@example.com"',
      },
    });
  });

  it("redacts sensitive tool input fields before policy logging", () => {
    expect(
      policyInputForTool(
        "customTool",
        {
          query: "hello",
          apiKey: "sk-secret",
          nested: { token: "secret", keep: "visible" },
        },
        [],
      ),
    ).toMatchObject({
      tool: {
        input: {
          query: "hello",
          apiKey: "[redacted]",
          nested: { token: "[redacted]", keep: "visible" },
        },
      },
    });
  });
});
