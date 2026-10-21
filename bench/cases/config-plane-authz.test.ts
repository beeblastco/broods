import { describe, expect, it } from "bun:test";
import type { BenchCase } from "../runner.ts";
import { configPlaneAuthzCases } from "./config-plane-authz.ts";

/** The case by name; fails the test rather than timing a renamed case silently. */
function benchCase(name: string): BenchCase {
  const found = configPlaneAuthzCases.find(
    (candidate) => candidate.name === name,
  );
  if (!found) throw new Error(`no bench case named ${name}`);

  return found;
}

// Each case times one decision. A fixture that drifts off it (as the stage pin
// did, refusing before any rule was read) reports a faster number for different
// work, so the decision itself is pinned here on the case's own run().
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
