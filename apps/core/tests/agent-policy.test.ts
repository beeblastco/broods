import { describe, expect, it } from "bun:test";
import { policyInputForTool } from "../functions/harness-processing/policy.ts";
import {
  normalizeAgentPolicyConfig,
  normalizeAgentPolicyDocument,
} from "../functions/_shared/storage/agent-policy.ts";
import type { ResolvedWorkspace } from "../functions/_shared/workspaces.ts";

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
      workspaceId: "ws_123",
      workspaceName: "repo",
      sandboxPermissionMode: "ask",
      filePath: "src/index.ts",
    });

    expect(policyInputForTool("bash", { workspace: "repo", command: "bun test" }, workspaces)).toMatchObject({
      action: "workspace.exec",
      toolName: "bash",
      workspaceId: "ws_123",
      workspaceName: "repo",
    });
  });

  it("maps skill and subagent references", () => {
    expect(policyInputForTool("load_skill", { path: "acct/skills/review/SKILL.md" }, [])).toEqual({
      action: "skill.load",
      toolName: "load_skill",
      skillPath: "acct/skills/review/SKILL.md",
    });

    expect(policyInputForTool("run_subagent", { tasks: [{ agentId: "agent_child", prompt: "check this" }] }, [])).toEqual({
      action: "subagent.run",
      toolName: "run_subagent",
      subagentId: "agent_child",
    });
  });

  it("defaults unknown tools to generic tool calls", () => {
    expect(policyInputForTool("tavilySearch", { query: "opa" }, [])).toEqual({
      action: "tool.call",
      toolName: "tavilySearch",
    });
  });
});

describe("agent policy validation", () => {
  it("rejects unknown config.policy keys instead of dropping them", () => {
    expect(() => normalizeAgentPolicyConfig({ enabbled: true })).toThrow("config.policy.enabbled is not supported");
    expect(normalizeAgentPolicyConfig({ enabled: true, policyIds: ["policy_a"], mode: "audit" })).toEqual({
      enabled: true,
      policyIds: ["policy_a"],
      mode: "audit",
    });
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
