/**
 * Sandbox config validation tests.
 * Cover provider limits, unsafe option rejection, and public secret redaction.
 */

import { describe, expect, it } from "bun:test";
import {
  normalizeCreateSandboxConfigInput,
  normalizeSandboxConfig,
  normalizeUpdateSandboxConfigInput,
  toPublicSandboxConfig,
  type SandboxConfig,
  type SandboxConfigRecord,
} from "../functions/_shared/storage/sandbox-config.ts";

describe("sandbox config", () => {
  it("rejects account-controlled lambda function-name overrides", () => {
    expect(() => normalizeSandboxConfig({
      provider: "lambda",
      options: { functionNames: { noMountNet: "other-function" } },
    })).toThrow("config.options.functionNames is not supported");
  });

  it("rejects account-controlled kubernetes cluster options", () => {
    expect(() => normalizeSandboxConfig({
      provider: "kubernetes",
      options: { serviceAccountName: "cluster-admin" },
    })).toThrow("config.options.serviceAccountName is managed by the service");
  });

  it("redacts env vars and sensitive provider option names", () => {
    const record: SandboxConfigRecord = {
      accountId: "acct_1",
      sandboxId: "sb_1",
      name: "secure",
      config: {
        provider: "kubernetes",
        envVars: { API_BASE: "https://api.example.com" },
        options: {
          kubeconfig: "base64-token",
          credentials: "secret-json",
          private_key: "pem",
          workspaceRoot: "/mnt/workspaces",
        },
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    expect(toPublicSandboxConfig(record).config).toEqual({
      provider: "kubernetes",
      envVars: { API_BASE: "********" },
      options: {
        kubeconfig: "********",
        credentials: "********",
        private_key: "********",
        workspaceRoot: "/mnt/workspaces",
      },
    });
  });
});

describe("sandbox config defaults & validation", () => {
  it("defaults to lambda + ask when config is empty or null", () => {
    expect(normalizeSandboxConfig(undefined)).toEqual({ provider: "lambda", permissionMode: "ask" });
    expect(normalizeSandboxConfig({})).toEqual({ provider: "lambda", permissionMode: "ask" });
  });

  it("rejects unknown providers, permission modes, and runtimes", () => {
    expect(() => normalizeSandboxConfig({ provider: "fargate" })).toThrow("config.provider must be one of");
    expect(() => normalizeSandboxConfig({ permissionMode: "auto" })).toThrow("config.permissionMode must be one of");
    expect(() => normalizeSandboxConfig({ runtimes: ["bash", "rust"] })).toThrow("config.runtimes must be a non-empty array");
    expect(() => normalizeSandboxConfig({ runtimes: [] })).toThrow("config.runtimes must be a non-empty array");
  });

  it("rejects non-string env vars, non-object options, and non-boolean internet", () => {
    expect(() => normalizeSandboxConfig({ envVars: { OK: 1 } })).toThrow("config.envVars must be an object with string values");
    expect(() => normalizeSandboxConfig({ options: "nope" })).toThrow("config.options must be an object");
    expect(() => normalizeSandboxConfig({ internet: "yes" })).toThrow("config.internet must be a boolean");
  });

  it("round-trips runtimes/internet/envVars and trims name/description through create input", () => {
    expect(normalizeCreateSandboxConfigInput({
      name: "  build  ",
      description: "  builder  ",
      config: { provider: "lambda", internet: true, runtimes: ["bash", "node"], envVars: { TOKEN: "abc" } },
    })).toEqual({
      name: "build",
      description: "builder",
      config: {
        provider: "lambda",
        permissionMode: "ask",
        internet: true,
        runtimes: ["bash", "node"],
        envVars: { TOKEN: "abc" },
      },
    });
  });
});

describe("sandbox config provider-aware limits", () => {
  it("bounds lambda timeout at 300s and memory at 1024MB", () => {
    expect(normalizeSandboxConfig({ provider: "lambda", timeout: 300 }).timeout).toBe(300);
    expect(() => normalizeSandboxConfig({ provider: "lambda", timeout: 301 }))
      .toThrow("config.timeout must be an integer from 1 to 300");
    expect(normalizeSandboxConfig({ provider: "lambda", memoryLimit: 1024 }).memoryLimit).toBe(1024);
    expect(() => normalizeSandboxConfig({ provider: "lambda", memoryLimit: 2048 }))
      .toThrow("config.memoryLimit must be an integer from 1 to 1024");
  });

  it("gives persistent providers a 600s ceiling and unbounded memory", () => {
    expect(normalizeSandboxConfig({ provider: "daytona", timeout: 600 }).timeout).toBe(600);
    expect(() => normalizeSandboxConfig({ provider: "daytona", timeout: 601 }))
      .toThrow("config.timeout must be an integer from 1 to 600");
    // Persistent providers are operator-sized: memory is validated but not capped.
    expect(normalizeSandboxConfig({ provider: "kubernetes", memoryLimit: 8192 }).memoryLimit).toBe(8192);
    expect(() => normalizeSandboxConfig({ provider: "kubernetes", memoryLimit: 0 }))
      .toThrow("config.memoryLimit must be a positive integer");
  });
});

describe("sandbox config update merge", () => {
  const existing: SandboxConfig = { provider: "lambda", permissionMode: "ask", envVars: { A: "1" } };

  it("deep-merges a config patch onto the existing config and re-validates", () => {
    const patched = normalizeUpdateSandboxConfigInput(existing, {
      config: { permissionMode: "bypass", envVars: { B: "2" } },
    });
    expect(patched.config).toEqual({
      provider: "lambda",
      permissionMode: "bypass",
      envVars: { A: "1", B: "2" },
    });
  });

  it("keeps the existing config when no config patch is given and clears description with null", () => {
    const patched = normalizeUpdateSandboxConfigInput(existing, { name: "renamed", description: null });
    expect(patched).toEqual({ name: "renamed", description: null, config: existing });
  });

  it("re-applies provider limits on update (lambda timeout > 300 rejected)", () => {
    expect(() => normalizeUpdateSandboxConfigInput(existing, { config: { timeout: 600 } }))
      .toThrow("config.timeout must be an integer from 1 to 300");
  });
});
