/**
 * Workdir HarnessAgent construction tests.
 * Live bridge bootstrap and connectivity are covered by the opt-in integration test.
 */

import { describe, expect, it } from "bun:test";
import {
  createWorkdirHarnessAgent,
  workdirHarnessVersion,
} from "../src/harness/harness-agent-runtime.ts";

const COMPUTE = {
  provider: "sandbox",
  persistent: true,
  network: { mode: "allow-all" },
  options: {
    workdirUrl: "https://workdir.example.test",
    apiKey: "test-key",
  },
} as const;

describe("createWorkdirHarnessAgent", () => {
  it.each(["claude-code", "codex"] as const)(
    "constructs the %s bridge on a version-scoped reservation",
    (harness) => {
      const runtime = createWorkdirHarnessAgent({
        harness,
        reservationKey: "acct:agent:conversation",
        compute: COMPUTE,
        bridgePort: 4_567,
      });

      expect(runtime.agent.harnessId).toBe(harness);
      expect(runtime.bridgePort).toBe(4_567);
      expect(runtime.reservationKey).toBe(
        `acct:agent:conversation:${harness}:${workdirHarnessVersion(harness)}`,
      );
      expect(runtime.sandbox.bridgePorts).toEqual([4_567]);
    },
  );

  it("rejects Codex permission modes the adapter cannot enforce", () => {
    expect(() =>
      createWorkdirHarnessAgent({
        harness: "codex",
        reservationKey: "acct:agent:conversation",
        compute: COMPUTE,
        permissionMode: "allow-edits",
      }),
    ).toThrow("Codex Harness requires permissionMode allow-all");
  });
});
