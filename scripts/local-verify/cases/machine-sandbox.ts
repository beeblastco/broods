/**
 * The machine sandbox: this computer joins the stack as a sandbox through the
 * gateway, and with a model key an agent runs bash on it. The daemon runs
 * in-process with the account secret as its credential, since the `broods
 * machine` CLI needs a dashboard login a local stack does not have.
 *
 * BROODS_VERIFY_COMPUTER=1 swaps bash for the computer tool. Opt-in, because
 * only a person can grant this terminal Screen Recording and Accessibility.
 */

import { hostname } from "node:os";

import { runMachineDaemon } from "../../../packages/broods/src/cli/machine.ts";
import {
  MODEL_KEY_HINT,
  assertStep,
  createAgent,
  httpJson,
  pollRunStatus,
  pollUntil,
  startRun,
  type VerifyCase,
  type VerifyContext,
} from "../harness.ts";

const MACHINE_CONNECT_TIMEOUT_MS = 15_000;

export const machineSandboxCase: VerifyCase = {
  name: "machine sandbox",
  run: async (context: VerifyContext): Promise<void> => {
    const sandboxName = `machine-${context.runId}`;
    const computer = process.env.BROODS_VERIFY_COMPUTER === "1";
    const created = await httpJson(`${context.gatewayUrl}/v1/sandboxes`, {
      method: "POST",
      token: context.accountSecret,
      body: {
        name: sandboxName,
        config: {
          provider: "machine",
          permissionMode: "bypass",
          network: { mode: "allow-all" },
        },
      },
    });
    const sandboxId = (created.body as { sandboxId?: string }).sandboxId;
    assertStep(
      "create machine sandbox (config plane via gateway)",
      created.status === 201 && typeof sandboxId === "string",
      `status ${created.status}: ${JSON.stringify(created.body)}`,
    );

    let daemonOutput = "";
    const controller = new AbortController();
    const daemon = runMachineDaemon({
      baseUrl: context.gatewayUrl,
      computer: computer,
      credential: async (): Promise<string> => context.accountSecret,
      cwd: process.cwd(),
      log: (line: string): void => {
        daemonOutput += `${line}\n`;
      },
      sandbox: sandboxName,
      signal: controller.signal,
    }).catch((error: unknown) => {
      daemonOutput += `daemon exited: ${error instanceof Error ? error.message : String(error)}\n`;
    });
    try {
      const connected = await context.measure("machine connect", () =>
        pollUntil(
          {
            initialIntervalMs: 100,
            maxIntervalMs: 500,
            timeoutMs: MACHINE_CONNECT_TIMEOUT_MS,
          },
          async () =>
            daemonOutput.includes(`connected as ${sandboxName}`) ? true : null,
        ),
      );
      assertStep(
        "machine daemon connected through the gateway",
        connected === true,
        daemonOutput,
      );
      if (!context.hasModelKey) {
        console.log(`  skip agent bash on this machine (${MODEL_KEY_HINT})`);

        return;
      }

      const agentId = await createAgent(context, sandboxName, {
        instructions: computer
          ? "Use the computer tool to take one screenshot, then reply with exactly the frontmost app it reported and nothing else."
          : "Use the bash tool to run `hostname`, then reply with exactly its output and nothing else.",
        sandboxes: [sandboxId],
      });
      const finalStatus = await context.measure("machine agent run", async () =>
        pollRunStatus(
          await startRun(context, {
            agentId: agentId,
            conversationKey: sandboxName,
            eventId: `${sandboxName}-run`,
            text: computer ? "What app is in front?" : "Run hostname.",
          }),
          context.accountSecret,
        ),
      );
      if (computer) {
        assertStep(
          "agent screenshot ran on this machine and the reply names an app",
          finalStatus.status === "completed" &&
            daemonOutput.includes("  screenshot") &&
            JSON.stringify(finalStatus.response ?? "").length > 2,
          `${JSON.stringify(finalStatus)}\n${daemonOutput}`,
        );

        return;
      }
      assertStep(
        "agent bash ran on this machine and the reply names this host",
        finalStatus.status === "completed" &&
          JSON.stringify(finalStatus.response ?? "").includes(hostname()) &&
          daemonOutput.includes("$ "),
        `${JSON.stringify(finalStatus)}\n${daemonOutput}`,
      );
    } finally {
      controller.abort();
      await daemon;
    }
  },
};
