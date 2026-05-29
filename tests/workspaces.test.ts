/**
 * Workspace namespace resolution tests.
 * Cover default, shared, and named workspace bindings.
 */

import { describe, expect, it } from "bun:test";
import { normalizeFilesystemNamespace } from "../functions/_shared/runtime-keys.ts";
import {
  resolveConfiguredWorkspaceNamespaces,
  resolveWorkspaceBindings,
} from "../functions/_shared/workspaces.ts";

const context = {
  accountId: "acct_test",
  agentId: "agent_test",
  conversationKey: "acct:acct_test:agent:agent_test:api:alpha",
};

describe("workspace namespace resolution", () => {
  it("keeps default workspaces conversation scoped", () => {
    const bindings = resolveWorkspaceBindings({ workspace: { enabled: true } }, context);

    expect(bindings).toEqual([{
      id: "default",
      namespace: normalizeFilesystemNamespace(`${context.accountId}:${context.agentId}:${context.conversationKey}`),
      isDefault: true,
    }]);
  });

  it("uses workspace namespace before legacy memory namespace", () => {
    const bindings = resolveWorkspaceBindings({
      workspace: {
        enabled: true,
        namespace: "support",
        memory: {
          namespace: "legacy-support",
        },
      },
    }, context);

    expect(bindings[0]?.namespace).toBe(
      normalizeFilesystemNamespace(`${context.accountId}:${context.agentId}:support`),
    );
  });

  it("resolves multiple named workspaces with isolated personal state and shared team state", () => {
    const bindings = resolveWorkspaceBindings({
      workspace: {
        enabled: true,
        defaultWorkspace: "personal",
        workspaces: {
          personal: {
            description: "Per-conversation workspace",
          },
          team: {
            namespace: "support-team",
            description: "Shared support workspace",
          },
        },
      },
    }, context);

    expect(bindings).toEqual([
      {
        id: "personal",
        namespace: normalizeFilesystemNamespace(`${context.accountId}:${context.agentId}:workspace:personal:${context.conversationKey}`),
        description: "Per-conversation workspace",
        isDefault: true,
      },
      {
        id: "team",
        namespace: normalizeFilesystemNamespace(`${context.accountId}:${context.agentId}:support-team`),
        description: "Shared support workspace",
        isDefault: false,
      },
    ]);
  });

  it("returns only configured shared namespaces for account cleanup", () => {
    const namespaces = resolveConfiguredWorkspaceNamespaces({
      workspace: {
        namespace: "fallback-default",
        defaultWorkspace: "personal",
        workspaces: {
          personal: {},
          team: {
            namespace: "support-team",
          },
        },
      },
    }, {
      accountId: context.accountId,
      agentId: context.agentId,
    });

    expect(namespaces).toEqual([
      normalizeFilesystemNamespace(`${context.accountId}:${context.agentId}:fallback-default`),
      normalizeFilesystemNamespace(`${context.accountId}:${context.agentId}:support-team`),
    ]);
  });
});
