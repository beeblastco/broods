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
    expect(normalizeSandboxConfig(undefined)).toEqual({ provider: "lambda", permissionMode: "ask", network: { mode: "deny-all" } });
    expect(normalizeSandboxConfig({})).toEqual({ provider: "lambda", permissionMode: "ask", network: { mode: "deny-all" } });
  });

  it("rejects unknown providers, permission modes, and runtimes", () => {
    expect(() => normalizeSandboxConfig({ provider: "fargate" })).toThrow("config.provider must be one of");
    expect(() => normalizeSandboxConfig({ permissionMode: "auto" })).toThrow("config.permissionMode must be one of");
    expect(() => normalizeSandboxConfig({ runtimes: ["bash", "rust"] })).toThrow("config.runtimes must be a non-empty array");
    expect(() => normalizeSandboxConfig({ runtimes: [] })).toThrow("config.runtimes must be a non-empty array");
  });

  it("rejects non-string env vars, non-object options, and the removed internet field", () => {
    expect(() => normalizeSandboxConfig({ envVars: { OK: 1 } })).toThrow("config.envVars must be an object with string values");
    expect(() => normalizeSandboxConfig({ options: "nope" })).toThrow("config.options must be an object");
    expect(() => normalizeSandboxConfig({ internet: true })).toThrow("config.internet is no longer supported");
  });

  it("defaults network to deny-all and validates restricted allowlists", () => {
    expect(normalizeSandboxConfig({ provider: "lambda" }).network).toEqual({ mode: "deny-all" });
    expect(normalizeSandboxConfig({
      provider: "vercel",
      network: { mode: "restricted", allowDomains: ["api.example.com"], allowCidrs: ["10.0.0.0/8"] },
    }).network).toEqual({ mode: "restricted", allowDomains: ["api.example.com"], allowCidrs: ["10.0.0.0/8"] });
    expect(() => normalizeSandboxConfig({ provider: "lambda", network: { mode: "allow-all", allowDomains: ["api.example.com"] } }))
      .toThrow("only valid when config.network.mode is restricted");
  });

  it("rejects e2b configs that do not explicitly allow all network egress", () => {
    expect(() => normalizeSandboxConfig({ provider: "e2b" }))
      .toThrow("e2b cannot enforce egress restrictions");
    expect(normalizeSandboxConfig({ provider: "e2b", network: { mode: "allow-all" } }).network)
      .toEqual({ mode: "allow-all" });
  });

  it("round-trips runtimes/network/envVars and trims name/description through create input", () => {
    expect(normalizeCreateSandboxConfigInput({
      name: "  build  ",
      description: "  builder  ",
      config: { provider: "lambda", network: { mode: "allow-all" }, runtimes: ["bash", "node"], envVars: { TOKEN: "abc" } },
    })).toEqual({
      name: "build",
      description: "builder",
      config: {
        provider: "lambda",
        permissionMode: "ask",
        network: { mode: "allow-all" },
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

describe("sandbox config persistent / lifecycle / PVC", () => {
  it("rejects persistent on the lambda provider", () => {
    expect(() => normalizeSandboxConfig({ provider: "lambda", persistent: true }))
      .toThrow("config.persistent is not supported by the lambda provider");
  });

  it("accepts persistent on kubernetes/daytona/e2b/vercel", () => {
    expect(normalizeSandboxConfig({ provider: "kubernetes", persistent: true }).persistent).toBe(true);
    expect(normalizeSandboxConfig({ provider: "daytona", persistent: true }).persistent).toBe(true);
    expect(normalizeSandboxConfig({ provider: "e2b", persistent: true, network: { mode: "allow-all" } }).persistent).toBe(true);
    expect(normalizeSandboxConfig({ provider: "vercel", persistent: true }).persistent).toBe(true);
  });

  it("requires persistent when lifecycle is set, and bounds its intervals", () => {
    expect(() => normalizeSandboxConfig({ provider: "kubernetes", lifecycle: { idleTimeoutSeconds: 600 } }))
      .toThrow("config.lifecycle requires config.persistent");
    expect(normalizeSandboxConfig({
      provider: "kubernetes",
      persistent: true,
      lifecycle: { idleTimeoutSeconds: 1800, maxLifetimeSeconds: 3600 },
    }).lifecycle).toEqual({ idleTimeoutSeconds: 1800, maxLifetimeSeconds: 3600 });
    expect(() => normalizeSandboxConfig({
      provider: "kubernetes",
      persistent: true,
      lifecycle: { idleTimeoutSeconds: 0 },
    })).toThrow("config.lifecycle.idleTimeoutSeconds must be a positive integer");
  });

  it("only allows ephemeral home on a persistent kubernetes sandbox", () => {
    expect(() => normalizeSandboxConfig({ provider: "kubernetes", ephemeralHome: true }))
      .toThrow("config.ephemeralHome requires a persistent kubernetes sandbox");
    expect(() => normalizeSandboxConfig({ provider: "daytona", persistent: true, ephemeralHome: true }))
      .toThrow("config.ephemeralHome requires a persistent kubernetes sandbox");
    expect(normalizeSandboxConfig({
      provider: "kubernetes",
      persistent: true,
      ephemeralHome: true,
    }).ephemeralHome).toBe(true);
  });

  it("requires persistent when lifecycle hooks are set", () => {
    expect(() => normalizeSandboxConfig({ provider: "kubernetes", onCreate: ["npm install"] }))
      .toThrow("config.onCreate and config.onResume require config.persistent");
    expect(() => normalizeSandboxConfig({ provider: "kubernetes", persistent: true, onResume: [] }))
      .toThrow("config.onResume must be a non-empty array");
    expect(normalizeSandboxConfig({
      provider: "vercel",
      persistent: true,
      onCreate: ["npm install"],
      onResume: ["npm run dev &"],
    })).toMatchObject({ onCreate: ["npm install"], onResume: ["npm run dev &"] });
    expect(() => normalizeSandboxConfig({
      provider: "e2b",
      persistent: true,
      network: { mode: "allow-all" },
      onCreate: ["npm install"],
    })).toThrow("config.onCreate and config.onResume are not supported by the e2b provider");
  });

  it("only allows PVC options on a persistent kubernetes sandbox", () => {
    expect(() => normalizeSandboxConfig({ provider: "kubernetes", options: { persistentDiskGb: 10 } }))
      .toThrow("config.options.persistentDiskGb requires a persistent kubernetes sandbox");
    expect(() => normalizeSandboxConfig({ provider: "daytona", persistent: true, options: { persistentHome: "/home/x" } }))
      .toThrow("config.options.persistentHome requires a persistent kubernetes sandbox");
    expect(() => normalizeSandboxConfig({ provider: "kubernetes", persistent: true, options: { persistentDiskGb: 11 } }))
      .toThrow("config.options.persistentDiskGb must be an integer from 1 to 10");
    expect(normalizeSandboxConfig({
      provider: "kubernetes",
      persistent: true,
      options: { persistentDiskGb: 10, persistentHome: "/home/node", storageClass: "local-path" },
    }).options).toEqual({ persistentDiskGb: 10, persistentHome: "/home/node", storageClass: "local-path" });
  });
});

describe("sandbox config update merge", () => {
  const existing: SandboxConfig = { provider: "lambda", permissionMode: "ask", network: { mode: "deny-all" }, envVars: { A: "1" } };

  it("deep-merges a config patch onto the existing config and re-validates", () => {
    const patched = normalizeUpdateSandboxConfigInput(existing, {
      config: { permissionMode: "bypass", envVars: { B: "2" } },
    });
    expect(patched.config).toEqual({
      provider: "lambda",
      permissionMode: "bypass",
      network: { mode: "deny-all" },
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
