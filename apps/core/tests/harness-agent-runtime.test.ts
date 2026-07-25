/**
 * Workdir HarnessAgent construction tests.
 * Each probe runs in a child process so importing the real driver cannot prime
 * Bun's module cache ahead of executor tests that install module-level fakes.
 * Live bridge bootstrap and connectivity are covered by the opt-in integration test.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "bun:test";

const COMPUTE = {
  provider: "sandbox",
  persistent: true,
  network: { mode: "allow-all" },
  options: {
    workdirUrl: "https://workdir.example.test",
    apiKey: "test-key",
  },
} as const;

const MODULE_URL = pathToFileURL(
  resolve(import.meta.dir, "../src/harness/harness-agent-runtime.ts"),
).href;

describe("createWorkdirHarnessAgent", () => {
  it.each(["claude-code", "codex"] as const)(
    "constructs the %s bridge on a version-scoped reservation",
    async (harness) => {
      const result = await runProbe(`
        const runtime = module.createWorkdirHarnessAgent({
          harness: ${JSON.stringify(harness)},
          reservationKey: "acct:agent:conversation",
          compute: ${JSON.stringify(COMPUTE)},
          bridgePort: 4567,
        });
        console.log(JSON.stringify({
          harnessId: runtime.agent.harnessId,
          bridgePort: runtime.bridgePort,
          reservationKey: runtime.reservationKey,
          expectedReservationKey:
            "acct:agent:conversation:" +
            ${JSON.stringify(harness)} +
            ":" +
            module.workdirHarnessVersion(${JSON.stringify(harness)}),
          bridgePorts: runtime.sandbox.bridgePorts,
        }));
      `);

      const parsed = JSON.parse(result);
      expect(parsed).toMatchObject({
        harnessId: harness,
        bridgePort: 4_567,
        bridgePorts: [4_567],
      });
      expect(parsed.reservationKey).toBe(parsed.expectedReservationKey);
    },
  );

  it("rejects Codex permission modes the adapter cannot enforce", async () => {
    const result = await runProbe(`
      try {
        module.createWorkdirHarnessAgent({
          harness: "codex",
          reservationKey: "acct:agent:conversation",
          compute: ${JSON.stringify(COMPUTE)},
          permissionMode: "allow-edits",
        });
      } catch (error) {
        console.log(error instanceof Error ? error.message : String(error));
      }
    `);

    expect(result).toBe("Codex Harness requires permissionMode allow-all");
  });
});

async function runProbe(body: string): Promise<string> {
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `const module = await import(${JSON.stringify(MODULE_URL)}); ${body}`,
    ],
    {
      cwd: resolve(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      stderr.trim() || `Harness runtime probe exited ${exitCode}`,
    );
  }
  return stdout.trim();
}
