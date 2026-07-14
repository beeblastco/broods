import { describe, expect, it } from "bun:test";
import { policyInputForTool } from "../src/harness/policy.ts";
import {
  normalizeAgentPolicyConfig,
  normalizeAgentPolicyDocument,
} from "../src/shared/domain/agent-policy.ts";
import type { ResolvedWorkspace } from "../src/shared/workspaces.ts";

const workspaces: ResolvedWorkspace[] = [{
  name: "repo",
  workspaceId: "ws_123",
  namespace: "repo-ns",
  config: { storage: { provider: "s3" } },
  sandbox: {
    provider: "lambda",
    permissionMode: "ask",
  },
}];

describe("agent policy input", () => {
  it("maps filesystem tool calls to workspace actions and trusted workspace context", () => {
    expect(policyInputForTool("read", { workspace: "repo", file_path: "src/index.ts" }, workspaces)).toEqual({
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

    expect(policyInputForTool("bash", { workspace: "repo", command: "bun test" }, workspaces)).toMatchObject({
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
  });

  it("maps skill and subagent references", () => {
    expect(policyInputForTool("load_skill", { path: "acct/skills/review/SKILL.md" }, [])).toEqual({
      action: "skill.load",
      toolName: "load_skill",
      tool: {
        input: { path: "acct/skills/review/SKILL.md" },
        inputKeys: ["path"],
        inputPreview: 'path="acct/skills/review/SKILL.md"',
      },
      skillPath: "acct/skills/review/SKILL.md",
    });

    expect(policyInputForTool("run_subagent", { tasks: [{ agentId: "agent_child", prompt: "check this" }] }, [])).toEqual({
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
    expect(policyInputForTool("tavilySearch", { query: "opa" }, [])).toEqual({
      action: "tool.call",
      toolName: "tavilySearch",
      tool: {
        input: { query: "opa" },
        inputKeys: ["query"],
        inputPreview: 'query="opa"',
      },
    });
  });

  it("maps uploaded tool model names to stable tool ids when provided", () => {
    expect(policyInputForTool("customer_lookup", { email: "a@example.com" }, [], {
      toolIdsByName: new Map([["customer_lookup", "qs78zwc4z4q5ysxm74fgrhd13s88xxt"]]),
    })).toEqual({
      action: "tool.call",
      toolName: "customer_lookup",
      toolId: "qs78zwc4z4q5ysxm74fgrhd13s88xxt",
      tool: {
        input: { email: "a@example.com" },
        inputKeys: ["email"],
        inputPreview: 'email="a@example.com"',
      },
    });
  });

  it("redacts sensitive tool input fields before policy logging", () => {
    expect(policyInputForTool("customTool", {
      query: "hello",
      apiKey: "sk-secret",
      nested: { token: "secret", keep: "visible" },
    }, [])).toMatchObject({
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

describe("agent policy validation", () => {
  it("rejects unknown config.policy keys instead of dropping them", () => {
    expect(() => normalizeAgentPolicyConfig({ enabbled: true })).toThrow("config.policy.enabbled is not supported");
    expect(normalizeAgentPolicyConfig({ enabled: true, policyIds: ["policy_a"], mode: "audit" })).toEqual({
      policyIds: ["policy_a"],
      mode: "audit",
    });
  });

  it("treats an empty config.policy object as no policy assignment", () => {
    expect(normalizeAgentPolicyConfig({})).toBeUndefined();
    expect(normalizeAgentPolicyConfig({ enabled: true })).toBeUndefined();
    expect(normalizeAgentPolicyConfig({ mode: "audit" })).toBeUndefined();
    expect(normalizeAgentPolicyConfig({ policyIds: [], mode: "enforce" })).toBeUndefined();
  });

  it("rejects unknown resource selector keys", () => {
    expect(() => normalizeAgentPolicyDocument({
      version: 1,
      rules: [{ effect: "deny", actions: ["workspace.exec"], resources: { toolName: ["bash"] } }],
    })).toThrow("policy rules[0].resources.toolName is not supported");
  });

  it("rejects heterogeneous condition value arrays", () => {
    const documentWithValue = (value: unknown) => ({
      version: 1,
      rules: [{
        effect: "deny",
        actions: ["tool.call"],
        conditions: [{ attribute: "environment", operator: "in", value }],
      }],
    });
    expect(() => normalizeAgentPolicyDocument(documentWithValue(["prod", 1, true]))).toThrow(
      "policy rules[0].conditions[0].value is invalid",
    );
    expect(() => normalizeAgentPolicyDocument(documentWithValue(["prod", "staging"]))).not.toThrow();
  });
});
