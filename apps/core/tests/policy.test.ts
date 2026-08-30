import { describe, expect, it } from "bun:test";
import { policyInputForTool } from "../src/harness/policy.ts";
import { normalizePolicyIds } from "../src/shared/domain/policy.ts";
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

    // memory_save derives its target path from the title, so the policy input
    // carries the same workspace.write + filePath surface as write/edit.
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

describe("policy attachment validation", () => {
  it("keeps the attachment a plain list of ids", () => {
    expect(
      normalizePolicyIds(["policy_a", "policy_b"], "config.policies"),
    ).toEqual(["policy_a", "policy_b"]);
    expect(() => normalizePolicyIds([1], "config.policies")).toThrow(
      "config.policies",
    );
  });

  it("treats an empty attachment as no policy at all", () => {
    expect(normalizePolicyIds(undefined, "config.policies")).toBeUndefined();
    expect(normalizePolicyIds([], "config.policies")).toBeUndefined();
  });

  // Attaching the same policy twice must not send it to OPA twice.
  it("drops duplicate ids", () => {
    expect(
      normalizePolicyIds(["policy_a", "policy_a"], "config.policies"),
    ).toEqual(["policy_a"]);
  });
});
