import { describe, expect, it } from "bun:test";
import type { BenchCase } from "../runner.ts";
import { configPlaneAuthzCases } from "./config-plane-authz.ts";

function benchCase(name: string): BenchCase {
  const found = configPlaneAuthzCases.find(
    (candidate) => candidate.name === name,
  );
  if (!found) throw new Error(`no bench case named ${name}`);

  return found;
}

// A fixture that drifts off its decision times different work, so each decision is pinned.
describe("config-plane authorize bench cases", (): void => {
  it("allow reaches the scoped write rule", (): void => {
    expect(benchCase("convex/api-authorize-allow").run()).toMatchObject({
      allow: true,
      matchedRuleIds: ["write-owned-agents"],
    });
  });

  it("default-deny walks every rule and matches none", (): void => {
    expect(benchCase("convex/api-authorize-default-deny").run()).toMatchObject({
      allow: false,
      matchedRuleIds: [],
      reason: expect.stringMatching(/^no rule allows /),
    });
  });
});
