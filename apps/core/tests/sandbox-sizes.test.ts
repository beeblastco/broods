import { describe, expect, it } from "bun:test";
import {
  knownSandboxSpecs,
  rememberReportedSpecs,
  resolveSandboxSpecs,
  workdirSizeResources,
  SANDBOX_SIZES,
} from "../src/shared/sandbox-sizes.ts";

describe("knownSandboxSpecs", () => {
  const config = SANDBOX_SIZES.xsmall;

  it("names no size for a self-sized provider until it reports one", () => {
    expect(knownSandboxSpecs("vercel", "key-v", config)).toBeUndefined();
    rememberReportedSpecs("key-v", { vcpu: 2, memoryMb: 4096 });
    expect(knownSandboxSpecs("vercel", "key-v", config)).toEqual({
      vcpu: 2,
      memoryMb: 4096,
    });
    rememberReportedSpecs("key-v", undefined);
    expect(knownSandboxSpecs("vercel", "key-v", config)).toBeUndefined();
  });

  it("keeps the config's size where the config sizes the machine", () => {
    expect(knownSandboxSpecs("sandbox", "key-s", config)).toEqual(config);
  });
});

describe("resolveSandboxSpecs", () => {
  it("returns the catalog specs for a pinned size", () => {
    expect(resolveSandboxSpecs({ size: "large" })).toEqual(SANDBOX_SIZES.large);
  });

  it("derives specs from explicit options, defaulting missing dimensions from xsmall", () => {
    expect(resolveSandboxSpecs({ options: { cpu: 2, diskGb: 32 } })).toEqual({
      vcpu: 2,
      memoryMb: SANDBOX_SIZES.xsmall.memoryMb,
      storageGb: 32,
    });
  });

  it("falls back to memoryLimit then to the xsmall default", () => {
    expect(resolveSandboxSpecs({ memoryLimit: 3000 })).toEqual({
      vcpu: SANDBOX_SIZES.xsmall.vcpu,
      memoryMb: 3000,
      storageGb: SANDBOX_SIZES.xsmall.storageGb,
    });
    expect(resolveSandboxSpecs({})).toEqual(SANDBOX_SIZES.xsmall);
  });

  it("reports a lambda MicroVM's real size whatever the config asks for", () => {
    const real = { vcpu: 4, memoryMb: 8192, storageGb: 8 };
    expect(resolveSandboxSpecs({ provider: "lambda" })).toEqual(real);
    expect(
      resolveSandboxSpecs({
        provider: "lambda",
        size: "tiny",
        options: { cpu: 1 },
        memoryLimit: 1024,
      }),
    ).toEqual(real);
  });

  it("reports the Cloudflare instance type a size starts", () => {
    expect(resolveSandboxSpecs({ provider: "cloudflare" })).toEqual({
      vcpu: 0.5,
      memoryMb: 4096,
      storageGb: 8,
    });
    expect(
      resolveSandboxSpecs({ provider: "cloudflare", size: "large" }),
    ).toEqual({ vcpu: 4, memoryMb: 12288, storageGb: 20 });
  });

  it("bills a workdir sandbox the resources its VM is created with", () => {
    // Explicit options win over the size, and the size's vcpu clamps like the VM's.
    expect(
      resolveSandboxSpecs({
        provider: "sandbox",
        size: "large",
        options: { cpu: 1 },
        memoryLimit: 3000,
      }),
    ).toEqual({ vcpu: 1, memoryMb: 3000, storageGb: 32 });
    expect(resolveSandboxSpecs({ provider: "sandbox", size: "tiny" })).toEqual({
      vcpu: 0.5,
      memoryMb: 512,
      storageGb: 8,
    });
    expect(resolveSandboxSpecs({ provider: "sandbox" })).toEqual(
      SANDBOX_SIZES.xsmall,
    );
  });

  it("ignores zero or negative resource options instead of billing nothing", () => {
    expect(
      resolveSandboxSpecs({
        provider: "e2b",
        options: { cpu: 0, memoryMb: -1, diskGb: 0 },
      }),
    ).toEqual(SANDBOX_SIZES.xsmall);
    expect(
      resolveSandboxSpecs({ provider: "sandbox", options: { cpu: 0 } }),
    ).toEqual(SANDBOX_SIZES.xsmall);
  });
});

describe("workdirSizeResources", () => {
  it("clamps vcpu up to workdir's allowed set", () => {
    // tiny is 0.25 vCPU; workdir's smallest choice is 0.5.
    expect(workdirSizeResources("tiny")).toEqual({
      cpu: 0.5,
      memoryMb: 512,
      diskGb: 8,
    });
    expect(workdirSizeResources("large")).toEqual({
      cpu: 4,
      memoryMb: 8192,
      diskGb: 32,
    });
  });
});
