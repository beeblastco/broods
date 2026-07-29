/**
 * Live Workdir coverage for the complete Broods Harness sandbox path.
 * This test uses a real Workdir server while keeping reservation persistence
 * local, so it never reads or mutates a shared Convex deployment.
 */

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createBroodsSandbox } from "@broods/ai-sdk-sandbox";
import {
  createWorkdirHarnessAgent,
  type WorkdirHarnessKind,
} from "../src/harness/harness-agent-runtime.ts";
import { createSandboxExecutor } from "../src/harness/sandbox/index.ts";
import { createWorkdirHarnessDriver } from "../src/harness/sandbox/workdir-harness-driver.ts";
import type { SandboxExecutorConfig } from "../src/harness/sandbox/types.ts";
import { runtime } from "../src/shared/convex/runtime.ts";

const KEY = process.env.WORKDIR_TEST_KEY ?? "";
const URL = process.env.WORKDIR_TEST_URL;
const originalWorkdirApiKey = process.env.WORKDIR_API_KEY;
const originalWorkdirUrl = process.env.WORKDIR_URL;
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
  if (URL?.startsWith("http://")) {
    process.env.WORKDIR_URL = URL;
    process.env.WORKDIR_API_KEY = KEY;
  }
});

afterEach(() => {
  runtime.mutate = originalMutation;
  runtime.query = originalQuery;
  restoreEnvironment("WORKDIR_API_KEY", originalWorkdirApiKey);
  restoreEnvironment("WORKDIR_URL", originalWorkdirUrl);
  mutationMock.mockClear();
  queryMock.mockClear();
  reservations.clear();
});

describe.skipIf(!URL)("Broods Workdir Harness integration (live)", () => {
  it("creates, executes, reads, writes, resumes, and destroys a real sandbox", async () => {
    const reservationKey = `broods-harness-live-${randomUUID()}`;
    const identity = `live-${randomUUID()}`;
    const sandbox = createBroodsSandbox({
      driver: createWorkdirHarnessDriver({
        reservationKey,
        bootstrapIdentity: identity,
        config: {
          provider: "sandbox",
          persistent: true,
          size: "tiny",
          network: { mode: "allow-all" },
          envVars: { BROODS_LIVE_DEFAULT: "configured" },
          ...(URL!.startsWith("https://")
            ? { options: { workdirUrl: URL!, apiKey: KEY } }
            : {}),
          controlPlane: {
            accountId: "workdir-live-test",
            name: "Workdir Harness live test",
            specs: { vcpu: 0.25, memoryMb: 512, storageGb: 8 },
          },
        },
      }),
    });
    const session = await sandbox.createSession({ identity });
    let cleanup = session;

    try {
      const command = await session.run({
        command:
          "printf 'hello-workdir:%s' \"$BROODS_LIVE_DEFAULT\" && printf 'to-stderr' >&2",
      });
      expect(command).toEqual({
        exitCode: 0,
        stdout: "hello-workdir:configured",
        stderr: "to-stderr",
      });

      const path = `${session.defaultWorkingDirectory}/broods-harness-live.txt`;
      await session.writeTextFile({ path, content: "live-file-content" });
      await expect(session.readTextFile({ path })).resolves.toBe(
        "live-file-content",
      );

      await session.stop();
      const resumed = await sandbox.resumeSession!({ sessionId: session.id });
      cleanup = resumed;
      await expect(
        resumed.run({ command: "printf 'resumed' && exit 7" }),
      ).resolves.toEqual({ exitCode: 7, stdout: "resumed", stderr: "" });
    } finally {
      await cleanup.destroy!();
    }

    expect(reservations.has(reservationKey)).toBe(false);
  }, 120_000);

  it.each(["claude-code", "codex"] as const)(
    "bootstraps and connects the real %s Harness bridge",
    async (harness) => {
      const compute = liveCompute();
      const created = createWorkdirHarnessAgent({
        harness,
        reservationKey: `broods-harness-${harness}-${randomUUID()}`,
        compute,
        harnessSettings: { startupTimeoutMs: 180_000 },
      });
      let session: Awaited<
        ReturnType<typeof created.agent.createSession>
      > | null = null;

      try {
        session = await created.agent.createSession({
          sessionId: `live-${harness}-${randomUUID()}`,
        });
        expect(session.sessionId).toStartWith(`live-${harness}-`);
      } finally {
        if (session) {
          await session.destroy();
        } else {
          await createSandboxExecutor(compute).release?.({
            reservationKey: created.reservationKey,
          });
        }
      }

      expect(reservations.has(created.reservationKey)).toBe(false);
    },
    240_000,
  );
});

function liveCompute(): SandboxExecutorConfig & {
  provider: "sandbox";
  persistent: true;
} {
  return {
    provider: "sandbox",
    persistent: true,
    size: "small",
    network: { mode: "allow-all" },
    ...(URL!.startsWith("https://")
      ? { options: { workdirUrl: URL!, apiKey: KEY } }
      : {}),
    controlPlane: {
      accountId: "workdir-live-test",
      name: "Workdir Harness live test",
      specs: { vcpu: 1, memoryMb: 2_048, storageGb: 8 },
    },
  };
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
