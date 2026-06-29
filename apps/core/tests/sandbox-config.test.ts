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
  it("accepts a predefined size and rejects an unknown one", () => {
    expect(normalizeSandboxConfig({ provider: "sandbox", size: "medium" }).size).toBe("medium");
    expect(normalizeSandboxConfig({ provider: "sandbox" }).size).toBeUndefined();
    expect(() => normalizeSandboxConfig({ provider: "sandbox", size: "huge" })).toThrow("config.size must be one of");
  });

  it("accepts a snapshot/image pin and rejects a non-string one", () => {
    expect(normalizeSandboxConfig({ provider: "sandbox", snapshot: "img_curated" }).snapshot).toBe("img_curated");
    expect(normalizeSandboxConfig({ provider: "sandbox" }).snapshot).toBeUndefined();
    expect(normalizeSandboxConfig({ provider: "sandbox", snapshot: "  " }).snapshot).toBeUndefined();
    expect(() => normalizeSandboxConfig({ provider: "sandbox", snapshot: 7 })).toThrow("config.snapshot must be a string");
  });

  it("rejects account-controlled lambda function-name overrides", () => {
    expect(() => normalizeSandboxConfig({
      provider: "lambda",
      options: { functionNames: { noMountNet: "other-function" } },
    })).toThrow("config.options.functionNames is not supported");
  });

  it("redacts env vars and sensitive provider option names", () => {
    const record: SandboxConfigRecord = {
      accountId: "acct_1",
      sandboxId: "sb_1",
      name: "secure",
      config: {
        provider: "sandbox",
        envVars: { API_BASE: "https://api.example.com" },
        options: {
          apiKey: "base64-token",
          credentials: "secret-json",
          private_key: "pem",
          workspaceRoot: "/mnt/workspaces",
        },
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    expect(toPublicSandboxConfig(record).config).toEqual({
      provider: "sandbox",
      envVars: { API_BASE: "********" },
      options: {
        apiKey: "********",
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
  it("bounds lambda (MicroVM) timeout at 600s and memory at the 8192MB max size", () => {
    expect(normalizeSandboxConfig({ provider: "lambda", timeout: 600 }).timeout).toBe(600);
    expect(() => normalizeSandboxConfig({ provider: "lambda", timeout: 601 }))
      .toThrow("config.timeout must be an integer from 1 to 600");
    expect(normalizeSandboxConfig({ provider: "lambda", memoryLimit: 8192 }).memoryLimit).toBe(8192);
    expect(() => normalizeSandboxConfig({ provider: "lambda", memoryLimit: 8193 }))
      .toThrow("config.memoryLimit must be an integer from 1 to 8192");
  });

  it("gives persistent providers a 600s ceiling and unbounded memory", () => {
    expect(normalizeSandboxConfig({ provider: "daytona", timeout: 600 }).timeout).toBe(600);
    expect(() => normalizeSandboxConfig({ provider: "daytona", timeout: 601 }))
      .toThrow("config.timeout must be an integer from 1 to 600");
    // Persistent providers are operator-sized: memory is validated but not capped.
    expect(normalizeSandboxConfig({ provider: "sandbox", memoryLimit: 8192 }).memoryLimit).toBe(8192);
    expect(() => normalizeSandboxConfig({ provider: "sandbox", memoryLimit: 0 }))
      .toThrow("config.memoryLimit must be a positive integer");
  });
});

describe("sandbox config persistent / lifecycle", () => {
  it("accepts persistent on the lambda (MicroVM) provider", () => {
    expect(normalizeSandboxConfig({ provider: "lambda", persistent: true }).persistent).toBe(true);
  });

  it("accepts persistent on sandbox/daytona/e2b/vercel", () => {
    expect(normalizeSandboxConfig({ provider: "sandbox", persistent: true }).persistent).toBe(true);
    expect(normalizeSandboxConfig({ provider: "daytona", persistent: true }).persistent).toBe(true);
    expect(normalizeSandboxConfig({ provider: "e2b", persistent: true, network: { mode: "allow-all" } }).persistent).toBe(true);
    expect(normalizeSandboxConfig({ provider: "vercel", persistent: true }).persistent).toBe(true);
  });

  it("requires persistent when lifecycle is set, and bounds its intervals", () => {
    expect(() => normalizeSandboxConfig({ provider: "sandbox", lifecycle: { idleTimeoutSeconds: 600 } }))
      .toThrow("config.lifecycle requires config.persistent");
    expect(normalizeSandboxConfig({
      provider: "sandbox",
      persistent: true,
      lifecycle: { idleTimeoutSeconds: 1800, maxLifetimeSeconds: 3600 },
    }).lifecycle).toEqual({ idleTimeoutSeconds: 1800, maxLifetimeSeconds: 3600 });
    expect(() => normalizeSandboxConfig({
      provider: "sandbox",
      persistent: true,
      lifecycle: { idleTimeoutSeconds: 0 },
    })).toThrow("config.lifecycle.idleTimeoutSeconds must be a positive integer");
  });

  it("requires persistent when lifecycle hooks are set", () => {
    expect(() => normalizeSandboxConfig({ provider: "sandbox", onCreate: ["npm install"] }))
      .toThrow("config.onCreate and config.onResume require config.persistent");
    expect(() => normalizeSandboxConfig({ provider: "sandbox", persistent: true, onResume: [] }))
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

  it("re-applies provider limits on update (lambda timeout > 600 rejected)", () => {
    expect(() => normalizeUpdateSandboxConfigInput(existing, { config: { timeout: 601 } }))
      .toThrow("config.timeout must be an integer from 1 to 600");
  });
});
