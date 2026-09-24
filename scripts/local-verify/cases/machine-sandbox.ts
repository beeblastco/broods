import { hostname } from "node:os";

import { runMachineDaemon } from "../../../packages/broods/src/cli/machine.ts";
import type { AsyncStatus } from "../../../packages/broods/src/types.ts";
import {
  MODEL_KEY_HINT,
  assertStep,
  pollUntil,
  runToTerminal,
  type VerifyContext,
} from "../harness.ts";

const MACHINE_CONNECT_TIMEOUT_MS = 15_000;

/**
 * This computer joins as a machine sandbox through the gateway, and with a
 * model key an agent runs bash on it. The daemon runs in-process on the
 * account secret because the `broods machine` CLI needs a dashboard login.
 * BROODS_VERIFY_COMPUTER=1 swaps bash for the computer tool.
 */
export async function machineSandbox(context: VerifyContext): Promise<void> {
  const name = `machine-${context.runId}`;
  const computer = process.env.BROODS_VERIFY_COMPUTER === "1";
  const { sandboxId } = await context.account.createSandbox({
    name: name,
    config: {
      provider: "machine",
      permissionMode: "bypass",
      network: { mode: "allow-all" },
    },
  });
  let output = "";
  const controller = new AbortController();
  const daemon = runMachineDaemon({
    baseUrl: context.gatewayUrl,
    computer: computer,
    credential: async (): Promise<string> => context.accountSecret,
    cwd: process.cwd(),
    log: (line: string): void => {
      output += `${line}\n`;
    },
    sandbox: name,
    signal: controller.signal,
  }).catch((error: unknown): void => {
    output += `daemon exited: ${String(error)}\n`;
  });
  try {
    const connected = await context.measure(
      "machine connect",
      (): Promise<true | null> =>
        pollUntil(
          {
            initialIntervalMs: 100,
            maxIntervalMs: 500,
            timeoutMs: MACHINE_CONNECT_TIMEOUT_MS,
          },
          async (): Promise<true | null> =>
            output.includes(`connected as ${name}`) ? true : null,
        ),
    );
    assertStep(
      "machine daemon connected through the gateway",
      connected === true,
      output,
    );
    if (!context.hasModelKey) {
      console.log(`  skip agent on this machine (${MODEL_KEY_HINT})`);
      return;
    }
    const { agentId } = await context.account.createAgent({
      name: name,
      config: {
        ...context.model,
        instructions: computer
          ? "Use the computer tool to take one screenshot, then reply with exactly the frontmost app it reported and nothing else."
          : "Use the bash tool to run `hostname`, then reply with exactly its output and nothing else.",
        sandboxes: [sandboxId],
      },
    });
    const status = await context.measure(
      "machine agent run",
      (): Promise<AsyncStatus> =>
        runToTerminal(context, {
          agentId: agentId,
          conversationKey: name,
          eventId: `${name}-run`,
          text: computer ? "What app is in front?" : "Run hostname.",
        }),
    );
    const reply = JSON.stringify(status.response ?? "");
    assertStep(
      computer
        ? "agent screenshot ran on this machine and the reply names an app"
        : "agent bash ran on this machine and the reply names this host",
      status.status === "completed" &&
        (computer
          ? output.includes("  screenshot") && reply.length > 2
          : output.includes("$ ") && reply.includes(hostname())),
      `${JSON.stringify(status)}\n${output}`,
    );
  } finally {
    controller.abort();
    await daemon;
  }
}
