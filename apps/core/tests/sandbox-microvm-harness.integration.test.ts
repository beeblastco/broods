/**
 * Opt-in live coverage for the Broods Harness path on AWS Lambda MicroVMs.
 *
 * This creates only uniquely named synthetic MicroVM reservations and keeps
 * persistence in memory. It never reads or mutates shared Convex state and
 * always terminates resources in `finally`.
 *
 * Run with:
 *   MICROVM_HARNESS_TEST=1 bun test tests/sandbox-microvm-harness.integration.test.ts
 */

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createBroodsSandbox } from "@broods/ai-sdk-sandbox";
import { createMicrovmHarnessAgent } from "../src/harness/ai-sdk-harness/index.ts";
import { createSandboxExecutor } from "../src/harness/sandbox/index.ts";
import { createMicrovmHarnessDriver } from "../src/harness/sandbox/microvm-harness-driver.ts";
import type { SandboxExecutorConfig } from "../src/harness/sandbox/types.ts";
import { runtime } from "../src/shared/convex/runtime.ts";

const ENABLED = process.env.MICROVM_HARNESS_TEST === "1";
const originalMutation = runtime.mutate;
const originalQuery = runtime.query;
const reservations = new Map<string, string>();
const mutationMock = mock(
  async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const reservationKey = String(args.reservationKey);
    if (name === "claimSandboxReservation") {
      if (reservations.has(reservationKey)) return false;
      reservations.set(reservationKey, String(args.externalId));
      return true;
    }
    if (name === "deleteSandboxReservation") {
      const expected = args.expectedExternalId;
      if (
        expected === undefined ||
        reservations.get(reservationKey) === expected
      ) {
        reservations.delete(reservationKey);
      }
      return null;
    }
    if (name === "saveSandboxReservation") {
      reservations.set(reservationKey, String(args.externalId));
      return null;
    }
    throw new Error(`Unexpected live-test runtime mutation: ${name}`);
  },
);
const queryMock = mock(
  async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    if (name !== "getSandboxReservation") {
      throw new Error(`Unexpected live-test runtime query: ${name}`);
    }
    return reservations.get(String(args.reservationKey)) ?? null;
  },
);

beforeEach(() => {
  reservations.clear();
  runtime.mutate = mutationMock as never;
  runtime.query = queryMock as never;
});

afterEach(() => {
  runtime.mutate = originalMutation;
  runtime.query = originalQuery;
  mutationMock.mockClear();
  queryMock.mockClear();
  reservations.clear();
});

describe.skipIf(!ENABLED)(
  "Broods Lambda MicroVM Harness integration (live)",
  () => {
    it("creates, executes, reads, writes, resumes, and destroys a synthetic MicroVM", async () => {
      const reservationKey = `broods-microvm-harness-live-${randomUUID()}`;
      const identity = `live-${randomUUID()}`;
      const compute = liveCompute();
      const sandbox = createBroodsSandbox({
        driver: createMicrovmHarnessDriver({
          reservationKey,
          bootstrapIdentity: identity,
          config: {
            ...compute,
            onCreate: ["mkdir -p /workspace"],
            envVars: { BROODS_LIVE_DEFAULT: "configured" },
          },
          ports: [4_321],
        }),
      });
      let session: Awaited<ReturnType<typeof sandbox.createSession>> | null =
        null;

      try {
        session = await sandbox.createSession({ identity });
        await expect(
          session.run({
            command:
              "printf 'hello-microvm:%s' \"$BROODS_LIVE_DEFAULT\" && printf 'to-stderr' >&2",
          }),
        ).resolves.toEqual({
          exitCode: 0,
          stdout: "hello-microvm:configured",
          stderr: "to-stderr",
        });

        const path = `${session.defaultWorkingDirectory}/broods-harness-live.txt`;
        await session.writeTextFile({ path, content: "live-file-content" });
        await expect(session.readTextFile({ path })).resolves.toBe(
          "live-file-content",
        );

        await session.stop();
        session = await sandbox.resumeSession!({ sessionId: session.id });
        await expect(
          session.run({ command: "printf 'resumed' && exit 7" }),
        ).resolves.toEqual({ exitCode: 7, stdout: "resumed", stderr: "" });
      } finally {
        if (session) await session.destroy!();
        else {
          await createSandboxExecutor(compute).release?.({ reservationKey });
        }
      }

      expect(reservations.has(reservationKey)).toBe(false);
    }, 180_000);

    it.each(["claude-code", "codex"] as const)(
      "bootstraps and connects the real %s bridge through the secure proxy",
      async (type) => {
        const compute = liveCompute();
        const created = createMicrovmHarnessAgent({
          type: type,
          reservationKey: `broods-microvm-harness-${type}-${randomUUID()}`,
          compute: compute,
          harnessSettings: { startupTimeoutMs: 240_000 },
        });
        let session: Awaited<
          ReturnType<typeof created.agent.createSession>
        > | null = null;

        try {
          session = await created.agent.createSession({
            sessionId: `live-${type}-${randomUUID()}`,
          });
          expect(session.sessionId).toStartWith(`live-${type}-`);
        } finally {
          if (session) await session.destroy();
          else {
            await createSandboxExecutor(compute).release?.({
              reservationKey: created.reservationKey,
            });
          }
        }

        expect(reservations.has(created.reservationKey)).toBe(false);
      },
      300_000,
    );
  },
);

function liveCompute(): SandboxExecutorConfig & {
  provider: "lambda";
  persistent: true;
} {
  const snapshot = process.env.MICROVM_IMAGE_IDENTIFIER;
  if (!snapshot) {
    throw new Error("MICROVM_HARNESS_TEST requires MICROVM_IMAGE_IDENTIFIER");
  }
  if (!process.env.AWS_REGION && !process.env.AWS_DEFAULT_REGION) {
    throw new Error("MICROVM_HARNESS_TEST requires an AWS region");
  }
  return {
    provider: "lambda",
    persistent: true,
    snapshot,
    network: { mode: "allow-all" },
    timeout: 180,
  };
}
