import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AsyncStatus } from "../../../packages/broods/src/types.ts";
import {
  MODEL_KEY_HINT,
  assertStep,
  connectMachine,
  runToTerminal,
  type VerifyContext,
} from "../harness.ts";

/**
 * An agent with `browser` on a sandbox without Obscura fails the run at tool
 * assembly with the change to make, before any model or AWS call. With a
 * model key, browse on this computer as a machine sandbox runs Obscura with
 * the sandbox's OBSCURA_ALLOW_PRIVATE_NETWORK unset; a stand-in `obscura`
 * reports what it saw, so no browser is needed.
 */
export async function browserSandbox(context: VerifyContext): Promise<void> {
  const key = `browser-${context.runId}`;
  const sandbox = await context.account.createSandbox({
    name: key,
    config: { provider: "lambda", network: { mode: "allow-all" } },
  });
  const { agentId } = await context.account.createAgent({
    name: key,
    config: {
      ...context.model,
      instructions: "Reply with the single word OK.",
      sandboxes: [sandbox.sandboxId],
      browser: { enabled: true },
    },
  });
  const status = await context.measure(
    "browser on a base image run",
    (): Promise<AsyncStatus> =>
      runToTerminal(context, {
        agentId: agentId,
        conversationKey: key,
        eventId: key,
        text: "Say OK.",
      }),
  );
  assertStep(
    "browser on a sandbox without the obscura image is refused",
    status.status === "failed" &&
      (status.error ?? "").includes('image: "obscura"'),
    JSON.stringify(status),
  );

  if (!context.hasModelKey) {
    console.log(`  skip browse on this machine (${MODEL_KEY_HINT})`);
    return;
  }
  await browseKeepsPrivateNetworkGuard(context, `${key}-machine`);
}

// browse on a machine sandbox whose env vars turn Obscura's private-network
// guard off: the stand-in obscura must not see that variable.
async function browseKeepsPrivateNetworkGuard(
  context: VerifyContext,
  name: string,
): Promise<void> {
  const bin = mkdtempSync(join(tmpdir(), "broods-obscura-"));
  writeFileSync(
    join(bin, "obscura"),
    '#!/bin/sh\necho "private-network-${OBSCURA_ALLOW_PRIVATE_NETWORK:-guarded}"\n',
  );
  chmodSync(join(bin, "obscura"), 0o755);
  const machine = await connectMachine(context, {
    computer: false,
    name: name,
    envVars: {
      OBSCURA_ALLOW_PRIVATE_NETWORK: "1",
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    },
  });
  try {
    const { agentId } = await context.account.createAgent({
      name: name,
      config: {
        ...context.model,
        instructions:
          "Call the browse tool once with url http://10.0.0.1/ and mode text, then reply with exactly the text it returned and nothing else.",
        sandboxes: [machine.sandboxId],
        browser: { enabled: true },
      },
    });
    const status = await context.measure(
      "browse on a machine run",
      (): Promise<AsyncStatus> =>
        runToTerminal(context, {
          agentId: agentId,
          conversationKey: name,
          eventId: `${name}-run`,
          text: 'Use browse on http://10.0.0.1/ with mode "text" and reply with exactly what it returned.',
        }),
    );
    const reply = JSON.stringify(status.response ?? "");
    assertStep(
      "browse keeps Obscura's private-network guard when the sandbox turns it off",
      status.status === "completed" &&
        reply.includes("private-network-guarded"),
      `${JSON.stringify(status)}\n${machine.output()}`,
    );
  } finally {
    await machine.stop();
    rmSync(bin, { recursive: true, force: true });
  }
}
