/**
 * workdir executor LIVE integration test (opt-in).
 * Unlike the unit/contract test, this hits a real workdir server over the
 * network — no mocked fetch — and asserts the connection works and the executor
 * maps real responses into the SandboxRunResult contract. Gated on
 * WORKDIR_TEST_URL so normal CI skips it. Run a local mock server with:
 *
 *   WORKDIR_DATA_DIR=/tmp/workdir WORKDIR_RUNTIME=mock \
 *   WORKDIR_ALLOW_INSECURE_RUNTIME=1 WORKDIR_ADMIN_KEY=sk_live_dev \
 *   WORKDIR_PUBLIC_DOMAIN=sandboxes.local ./target/release/workdir serve
 *
 * then: WORKDIR_TEST_URL=http://127.0.0.1:8080 WORKDIR_TEST_KEY=sk_live_dev \
 *   bun test tests/workdir-executor.integration.test.ts
 */

import { describe, expect, it } from "bun:test";
import { WorkdirSandboxExecutor } from "../functions/harness-processing/sandbox/workdir-executor.ts";

const URL = process.env.WORKDIR_TEST_URL;
const KEY = process.env.WORKDIR_TEST_KEY ?? "";

describe.skipIf(!URL)("WorkdirSandboxExecutor (live)", () => {
  function executor() {
    return new WorkdirSandboxExecutor({
      provider: "sandbox",
      network: { mode: "allow-all" },
      options: { workdirUrl: URL!, apiKey: KEY },
    });
  }

  it("connects, execs, and returns a real ExecResult mapped to SandboxRunResult", async () => {
    const result = await executor().run({
      code: "echo hello-workdir && echo to-stderr 1>&2",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
    });

    expect(result.provider).toBe("sandbox");
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(typeof result.exitCode).toBe("number");
    expect(result.stdout).toContain("hello-workdir");
    expect(result.stderr).toContain("to-stderr");
    expect(typeof result.durationMs).toBe("number");
  });

  it("surfaces a non-zero exit code as ok:false", async () => {
    const result = await executor().run({
      code: "exit 7",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(7);
  });
});
