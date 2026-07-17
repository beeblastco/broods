/**
 * Workspace config validation tests.
 * Cover defaults, storage/harness validation, create/update normalization, and
 * the (secret-free) public projection.
 */

import { describe, expect, it } from "bun:test";
import {
  normalizeCreateWorkspaceConfigInput,
  normalizeUpdateWorkspaceConfigInput,
  normalizeWorkspaceConfig,
  toPublicWorkspaceConfig,
  type WorkspaceConfig,
  type WorkspaceConfigRecord,
} from "../src/shared/domain/workspace-config.ts";

describe("workspace config", () => {
  it("defaults to an s3 workspace when config is empty or null", () => {
    expect(normalizeWorkspaceConfig(undefined)).toEqual({ storage: { provider: "s3" } });
    expect(normalizeWorkspaceConfig({})).toEqual({ storage: { provider: "s3" } });
  });

  it("rejects unsupported storage providers plus non-object storage/harness", () => {
    expect(() => normalizeWorkspaceConfig({ storage: { provider: "vercel" } }))
      .toThrow('config.storage.provider "vercel" is not supported yet');
    expect(() => normalizeWorkspaceConfig({ storage: { provider: "gcs" } }))
      .toThrow("config.storage.provider must be one of: s3");
    expect(() => normalizeWorkspaceConfig({ storage: "s3" }))
      .toThrow("config.storage must be an object");
    expect(() => normalizeWorkspaceConfig({ harness: true }))
      .toThrow("config.harness must be an object");
    expect(() => normalizeWorkspaceConfig({ harness: { workspace: "yes" } }))
      .toThrow("config.harness.workspace must be an object");
    expect(() => normalizeWorkspaceConfig({ harness: { workspace: { enabled: "yes" } } }))
      .toThrow("config.harness.workspace.enabled must be a boolean");
  });

  it("keeps harness feature toggles when present and drops unknown fields", () => {
    expect(normalizeWorkspaceConfig({ storage: { provider: "s3" }, harness: { workspace: { enabled: false } }, extra: "x" }))
      .toEqual({ storage: { provider: "s3" }, harness: { workspace: { enabled: false } } });
    // The legacy top-level harness.enabled flag is gone; unknown harness keys drop.
    expect(normalizeWorkspaceConfig({ storage: { provider: "s3" }, harness: { enabled: true } }))
      .toEqual({ storage: { provider: "s3" } });
  });

  it("normalizes the harness memory toggle and validates its shape", () => {
    expect(normalizeWorkspaceConfig({ storage: { provider: "s3" }, harness: { memory: { enabled: false } } }))
      .toEqual({ storage: { provider: "s3" }, harness: { memory: { enabled: false } } });
    expect(normalizeWorkspaceConfig({ storage: { provider: "s3" }, harness: { workspace: { enabled: true }, memory: {} } }))
      .toEqual({ storage: { provider: "s3" }, harness: { workspace: { enabled: true } } });
    expect(() => normalizeWorkspaceConfig({ harness: { memory: true } }))
      .toThrow("config.harness.memory must be an object");
    expect(() => normalizeWorkspaceConfig({ harness: { memory: { enabled: "yes" } } }))
      .toThrow("config.harness.memory.enabled must be a boolean");
  });

  it("defaults both harness features on and toggles them independently", async () => {
    const { workspaceGuidanceEnabled, workspaceMemoryHarnessEnabled } = await import("../src/shared/domain/workspace-config.ts");
    expect(workspaceMemoryHarnessEnabled({ storage: { provider: "s3" } })).toBe(true);
    expect(workspaceMemoryHarnessEnabled(undefined)).toBe(true);
    expect(workspaceGuidanceEnabled({ storage: { provider: "s3" } })).toBe(true);
    expect(workspaceGuidanceEnabled(undefined)).toBe(true);
    // The toggles are orthogonal: turning one feature off leaves the other on.
    const workspacePromptOff = { storage: { provider: "s3" as const }, harness: { workspace: { enabled: false } } };
    expect(workspaceGuidanceEnabled(workspacePromptOff)).toBe(false);
    expect(workspaceMemoryHarnessEnabled(workspacePromptOff)).toBe(true);
    const memoryOff = { storage: { provider: "s3" as const }, harness: { memory: { enabled: false } } };
    expect(workspaceGuidanceEnabled(memoryOff)).toBe(true);
    expect(workspaceMemoryHarnessEnabled(memoryOff)).toBe(false);
  });

  it("accepts boolean workspace isolation and rejects old string modes", () => {
    expect(normalizeWorkspaceConfig({ storage: { provider: "s3" }, isolation: true }))
      .toEqual({ storage: { provider: "s3" }, isolation: true });
    expect(normalizeWorkspaceConfig({ storage: { provider: "s3" }, isolation: false }))
      .toEqual({ storage: { provider: "s3" } });
    expect(() => normalizeWorkspaceConfig({ isolation: "channel" }))
      .toThrow("config.isolation must be a boolean");
  });

  it("parses a bring-your-own bucket with assume-role auth", () => {
    expect(normalizeWorkspaceConfig({
      storage: {
        provider: "s3",
        bucket: "acme-workspaces",
        region: "us-west-2",
        endpoint: "https://s3.us-west-2.amazonaws.com",
        prefix: "agents/",
        auth: { type: "assumeRole", roleArn: "arn:aws:iam::111122223333:role/broods-mount", externalId: "ext-1" },
      },
    })).toEqual({
      storage: {
        provider: "s3",
        bucket: "acme-workspaces",
        region: "us-west-2",
        endpoint: "https://s3.us-west-2.amazonaws.com",
        prefix: "agents/",
        auth: { type: "assumeRole", roleArn: "arn:aws:iam::111122223333:role/broods-mount", externalId: "ext-1" },
      },
    });
  });

  it("accepts managed auth and an assume-role without externalId", () => {
    expect(normalizeWorkspaceConfig({ storage: { provider: "s3", auth: { type: "managed" } } }))
      .toEqual({ storage: { provider: "s3", auth: { type: "managed" } } });
    expect(normalizeWorkspaceConfig({
      storage: { provider: "s3", bucket: "b", auth: { type: "assumeRole", roleArn: "arn:aws:iam::1:role/r" } },
    })).toEqual({
      storage: { provider: "s3", bucket: "b", auth: { type: "assumeRole", roleArn: "arn:aws:iam::1:role/r" } },
    });
  });

  it("rejects malformed storage auth and fields", () => {
    expect(() => normalizeWorkspaceConfig({ storage: { provider: "s3", auth: { type: "assumeRole" } } }))
      .toThrow("config.storage.auth.roleArn must be a non-empty string");
    expect(() => normalizeWorkspaceConfig({ storage: { provider: "s3", auth: { type: "keys" } } }))
      .toThrow("config.storage.auth.type must be one of: managed, assumeRole");
    expect(() => normalizeWorkspaceConfig({ storage: { provider: "s3", auth: "managed" } }))
      .toThrow("config.storage.auth must be an object");
    expect(() => normalizeWorkspaceConfig({ storage: { provider: "s3", bucket: 5 } }))
      .toThrow("config.storage.bucket must be a string");
  });

  it("trims name/description through create input", () => {
    expect(normalizeCreateWorkspaceConfigInput({
      name: "  notes  ",
      description: "  shared notes  ",
      config: { harness: { workspace: { enabled: false } } },
    })).toEqual({
      name: "notes",
      description: "shared notes",
      config: { storage: { provider: "s3" }, harness: { workspace: { enabled: false } } },
    });
  });

  it("merges a config patch on update and clears description with null", () => {
    const existing: WorkspaceConfig = { storage: { provider: "s3" }, harness: { workspace: { enabled: false } } };
    const patched = normalizeUpdateWorkspaceConfigInput(existing, {
      name: "renamed",
      description: null,
      config: { harness: { workspace: { enabled: true } } },
    });
    expect(patched).toEqual({
      name: "renamed",
      description: null,
      config: { storage: { provider: "s3" }, harness: { workspace: { enabled: true } } },
    });
  });

  it("keeps the existing config when no config patch is supplied", () => {
    const existing: WorkspaceConfig = { storage: { provider: "s3" }, harness: { workspace: { enabled: true } } };
    expect(normalizeUpdateWorkspaceConfigInput(existing, { name: "renamed" }))
      .toEqual({ name: "renamed", config: existing });
  });

  it("returns the record unchanged from the public projection (no secrets)", () => {
    const record: WorkspaceConfigRecord = {
      accountId: "acct_1",
      workspaceId: "ws_1",
      name: "notes",
      config: { storage: { provider: "s3" } },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(toPublicWorkspaceConfig(record)).toEqual(record);
  });
});
