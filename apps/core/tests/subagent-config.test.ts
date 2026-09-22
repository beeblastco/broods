/** A child carries the policies and withheld tools of the parent it runs under. */

import { describe, expect, it } from "bun:test";
import { subagentConfig } from "../src/harness/tools/utils.ts";

describe("subagentConfig", (): void => {
  it("carries the parent's policies and withheld tools onto a predefined child", (): void => {
    const child = subagentConfig(
      { policies: ["policy_child"], subagent: { enabled: true } },
      { policies: ["policy_room"], denyTools: ["bash"] },
    );

    expect(child).toEqual({
      policies: ["policy_room", "policy_child"],
      denyTools: ["bash"],
      subagent: { enabled: false },
    });
  });

  it("leaves a virtual child with exactly the parent's config", (): void => {
    const parent = { policies: ["policy_room"], denyTools: ["bash"] };

    expect(subagentConfig(parent, parent)).toEqual({
      ...parent,
      subagent: { enabled: false },
    });
  });
});
