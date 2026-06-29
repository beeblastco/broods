/**
 * Sandbox size catalog tests.
 * Cover specs resolution (pinned size vs. derived from options) and the workdir
 * vcpu clamp.
 */

import { describe, expect, it } from "bun:test";
import { resolveSandboxSpecs, workdirSizeResources, SANDBOX_SIZES } from "../functions/_shared/sandbox-sizes.ts";

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
});

describe("workdirSizeResources", () => {
  it("clamps vcpu up to workdir's allowed set", () => {
    // tiny is 0.25 vCPU; workdir's smallest choice is 0.5.
    expect(workdirSizeResources("tiny")).toEqual({ cpu: 0.5, memoryMb: 512, diskGb: 8 });
    expect(workdirSizeResources("large")).toEqual({ cpu: 4, memoryMb: 8192, diskGb: 32 });
  });
});
