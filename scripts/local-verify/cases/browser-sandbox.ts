import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BroodsSyncClient } from "../../../packages/broods/src/sync.ts";
import type { AsyncStatus } from "../../../packages/broods/src/types.ts";
import {
  OK_AGENT,
  MODEL_KEY_HINT,
  assertStep,
  connectMachine,
  runToTerminal,
  type VerifyContext,
} from "../harness.ts";

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
      agent: OK_AGENT,
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
  const synced = await new BroodsSyncClient({
    baseUrl: context.edgeUrl,
    token: context.accountSecret,
  })
    .putManifest(
      {
        version: 1,
        project: key,
        stage: "development",
        resources: [
          {
            kind: "sandbox",
            name: "web",
            config: { provider: "lambda", network: { mode: "allow-all" } },
          },
          {
            kind: "agent",
            name: "web",
            config: {
              model: context.model.model,
              agent: OK_AGENT,
              sandboxes: ["web"],
              browser: { enabled: true },
            },
          },
        ],
      },
      true,
    )
    .then(
      (): string => "accepted",
      (error: unknown): string => String(error),
    );
  assertStep(
    "a manifest pairing browser with a sandbox without obscura is refused at sync",
    synced.includes('image: "obscura"'),
    synced,
  );

  if (!context.hasModelKey) {
    console.log(`  skip browse on this machine (${MODEL_KEY_HINT})`);
    return;
  }
  await browseKeepsPrivateNetworkGuard(context, `${key}-machine`);
}

// A stand-in obscura echoes the guard variable it sees, so no browser is needed.
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
  }).catch((error: unknown): never => {
    rmSync(bin, { recursive: true, force: true });
    throw error;
  });
  try {
    const { agentId } = await context.account.createAgent({
      name: name,
      config: {
        ...context.model,
        agent: {
          system:
            "Call the browse tool once with url http://10.0.0.1/ and mode text, then reply with exactly the text it returned and nothing else.",
        },
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
