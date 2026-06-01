/**
 * Workspace + sandbox runtime resolution tests.
 * Cover shared-namespace derivation, bindings, and reference resolution.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { normalizeFilesystemNamespace } from "../functions/_shared/runtime-keys.ts";
import {
  resolveAgentRuntime,
  workspaceNamespace,
} from "../functions/_shared/workspaces.ts";
import { setStorageForTests } from "../functions/_shared/storage/index.ts";

afterEach(() => {
  setStorageForTests(null);
});

describe("workspaceNamespace", () => {
  it("scopes by accountId:workspaceId so the workspace is shared across agents", () => {
    expect(workspaceNamespace("acct_1", "ws_a")).toBe(normalizeFilesystemNamespace("acct_1:ws_a"));
    expect(workspaceNamespace("acct_1", "ws_a")).not.toBe(workspaceNamespace("acct_1", "ws_b"));
    // Same workspaceId resolves to the same namespace regardless of caller.
    expect(workspaceNamespace("acct_1", "ws_a")).toBe(workspaceNamespace("acct_1", "ws_a"));
  });
});

describe("resolveAgentRuntime", () => {
  it("resolves sandbox + workspace references through storage", async () => {
    setStorageForTests({
      sandboxConfigs: {
        getById: async (_accountId: string, id: string) =>
          id === "sb_1" ? { config: { provider: "lambda", permissionMode: "ask" } } : null,
      },
      workspaceConfigs: {
        getById: async (_accountId: string, id: string) =>
          id === "ws_a" ? { config: { storage: { provider: "s3" } }, description: "notes ws" } : null,
      },
    } as never);

    const resolved = await resolveAgentRuntime(
      { sandbox: "sb_1", workspaces: [{ name: "notes", workspaceId: "ws_a" }] },
      "acct_1",
    );

    expect(resolved.sandbox).toMatchObject({ provider: "lambda", permissionMode: "ask" });
    // The workspace inherits the agent-level sandbox as its effective sandbox.
    expect(resolved.workspaces).toEqual([{
      name: "notes",
      workspaceId: "ws_a",
      namespace: workspaceNamespace("acct_1", "ws_a"),
      description: "notes ws",
      config: { storage: { provider: "s3" } },
      sandbox: { provider: "lambda", permissionMode: "ask" },
    }]);
  });

  it("lets a workspace override the agent-level sandbox per agent", async () => {
    setStorageForTests({
      sandboxConfigs: {
        getById: async (_accountId: string, id: string) => {
          if (id === "sb_default") return { config: { provider: "lambda", permissionMode: "ask" } };
          if (id === "sb_bypass") return { config: { provider: "lambda", permissionMode: "bypass" } };
          return null;
        },
      },
      workspaceConfigs: {
        getById: async (_accountId: string, id: string) =>
          id === "ws_a" ? { config: { storage: { provider: "s3" } } } : null,
      },
    } as never);

    const resolved = await resolveAgentRuntime(
      { sandbox: "sb_default", workspaces: [{ name: "notes", workspaceId: "ws_a", sandbox: "sb_bypass" }] },
      "acct_1",
    );

    expect(resolved.sandbox).toMatchObject({ permissionMode: "ask" });
    expect(resolved.workspaces[0]?.sandbox).toMatchObject({ permissionMode: "bypass" });
  });

  it("lets a workspace opt out of the agent-level default with sandbox: null", async () => {
    setStorageForTests({
      sandboxConfigs: {
        getById: async (_accountId: string, id: string) =>
          id === "sb_default" ? { config: { provider: "lambda", permissionMode: "ask" } } : null,
      },
      workspaceConfigs: {
        getById: async (_accountId: string, id: string) =>
          ({ ws_rw: true, ws_ro: true }[id] ? { config: { storage: { provider: "s3" } } } : null),
      },
    } as never);

    const resolved = await resolveAgentRuntime(
      {
        sandbox: "sb_default",
        workspaces: [
          { name: "rw", workspaceId: "ws_rw" },              // inherits the default
          { name: "ro", workspaceId: "ws_ro", sandbox: null }, // forced read-only
        ],
      },
      "acct_1",
    );

    expect(resolved.workspaces[0]?.sandbox).toMatchObject({ permissionMode: "ask" });
    expect(resolved.workspaces[1]?.sandbox).toBeUndefined();
  });

  it("resolves a read-only workspace (no agent sandbox, no override) without a sandbox", async () => {
    setStorageForTests({
      sandboxConfigs: { getById: async () => null },
      workspaceConfigs: {
        getById: async (_accountId: string, id: string) =>
          id === "ws_a" ? { config: { storage: { provider: "s3" } } } : null,
      },
    } as never);

    const resolved = await resolveAgentRuntime(
      { workspaces: [{ name: "notes", workspaceId: "ws_a" }] },
      "acct_1",
    );

    expect(resolved.sandbox).toBeUndefined();
    expect(resolved.workspaces[0]?.sandbox).toBeUndefined();
  });

  it("throws a clear error when a referenced sandbox is missing", async () => {
    setStorageForTests({
      sandboxConfigs: { getById: async () => null },
      workspaceConfigs: { getById: async () => null },
    } as never);

    await expect(resolveAgentRuntime({ sandbox: "missing" }, "acct_1")).rejects.toThrow(
      /Referenced sandbox not found/,
    );
  });
});
