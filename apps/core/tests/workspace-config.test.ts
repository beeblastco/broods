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
} from "../functions/_shared/storage/workspace-config.ts";

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
    expect(() => normalizeWorkspaceConfig({ harness: { enabled: "yes" } }))
      .toThrow("config.harness.enabled must be a boolean");
  });

  it("keeps harness.enabled when present and drops unknown fields", () => {
    expect(normalizeWorkspaceConfig({ storage: { provider: "s3" }, harness: { enabled: true }, extra: "x" }))
      .toEqual({ storage: { provider: "s3" }, harness: { enabled: true } });
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
      config: { harness: { enabled: false } },
    })).toEqual({
      name: "notes",
      description: "shared notes",
      config: { storage: { provider: "s3" }, harness: { enabled: false } },
    });
  });

  it("merges a config patch on update and clears description with null", () => {
    const existing: WorkspaceConfig = { storage: { provider: "s3" }, harness: { enabled: false } };
    const patched = normalizeUpdateWorkspaceConfigInput(existing, {
      name: "renamed",
      description: null,
      config: { harness: { enabled: true } },
    });
    expect(patched).toEqual({
      name: "renamed",
      description: null,
      config: { storage: { provider: "s3" }, harness: { enabled: true } },
    });
  });

  it("keeps the existing config when no config patch is supplied", () => {
    const existing: WorkspaceConfig = { storage: { provider: "s3" }, harness: { enabled: true } };
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
