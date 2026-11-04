import { WorkerEntrypoint } from "cloudflare:workers";
import {
  Bash,
  type BashExecResult,
  type NetworkConfig,
} from "just-bash/browser";
import type { WorkerExecRequest, RuntimeExecResult } from "./contract.ts";
import { MAX_OUTPUT_BYTES } from "./limits.ts";
import {
  compressState,
  decodeState,
  emptyFs,
  packState,
  samePacked,
} from "./vfs-state.ts";

// Private-range checks need DNS pinning a Worker cannot do; Cloudflare egress reaches none.
const INTERNET: NetworkConfig = {
  dangerouslyAllowFullInternetAccess: true,
  allowedMethods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  denyPrivateRanges: false,
};
const DEADLINE_EXIT_CODE = 124;
// just-bash's cap is total and fatal, so it only bounds memory, well above the per-stream cut.
const MAX_TOTAL_OUTPUT_BYTES = 8 * MAX_OUTPUT_BYTES;
const MAX_UTF8_BYTES_PER_UNIT = 3;
const UTF8_ENCODER = new TextEncoder();

export class Runtime extends WorkerEntrypoint {
  async exec(
    request: WorkerExecRequest,
    state: Uint8Array | null,
  ): Promise<RuntimeExecResult> {
    const before = state === null ? null : await decodeState(state);
    const fs = before === null ? emptyFs() : before.fs;
    await fs.mkdir(request.cwd, { recursive: true });
    const bash = new Bash({
      fs: fs,
      cwd: request.cwd,
      env: request.env,
      executionLimits: {
        maxExecutionTimeMs: request.timeoutMs,
        maxOutputSize: MAX_TOTAL_OUTPUT_BYTES,
      },
      ...(request.enableInternet ? { network: INTERNET } : {}),
    });
    // The clock moves only on I/O: the deadline catches a slow command, the CPU limit a busy one.
    const startedAt = Date.now();
    const pastDeadline = (): boolean =>
      Date.now() - startedAt >= request.timeoutMs;
    const result = await bash
      .exec(withPositionals(request.script, request.args), {
        cwd: request.cwd,
        rawScript: true,
      })
      .then(
        (finished): RuntimeExecResult["result"] =>
          execResult(
            finished,
            request,
            finished.exitCode === DEADLINE_EXIT_CODE && pastDeadline(),
          ),
        (error: unknown): RuntimeExecResult["result"] =>
          execResult(
            {
              stdout: "",
              stderr: error instanceof Error ? error.message : String(error),
              exitCode: 1,
              env: {},
            },
            request,
            pastDeadline(),
          ),
      );
    if (!request.persist) return { result: result, state: null };
    const after = await packState(fs, request.cwd);
    if (samePacked(before?.packed ?? null, after))
      return { result: result, state: "unchanged" };

    return {
      result: result,
      state: after === null ? null : compressState(after),
    };
  }
}

// A streaming decode holds back a character the cut split instead of replacing it.
function capped(
  text: string,
  limit: number,
): { text: string; truncated: boolean } {
  if (text.length * MAX_UTF8_BYTES_PER_UNIT <= limit)
    return { text: text, truncated: false };
  const bytes = UTF8_ENCODER.encode(text);
  if (bytes.byteLength <= limit) return { text: text, truncated: false };

  return {
    text: new TextDecoder().decode(bytes.subarray(0, limit), { stream: true }),
    truncated: true,
  };
}

function execResult(
  finished: BashExecResult,
  request: WorkerExecRequest,
  timedOut: boolean,
): RuntimeExecResult["result"] {
  const stdout = capped(finished.stdout, request.outputLimitBytes);
  const stderr = capped(finished.stderr, request.outputLimitBytes);

  return {
    ok: !timedOut && finished.exitCode === 0,
    exit_code: timedOut ? null : finished.exitCode,
    timed_out: timedOut,
    stdout: stdout.text,
    stderr: stderr.text,
    truncated: stdout.truncated || stderr.truncated,
  };
}

// just-bash's exec `args` go to the first command, not `$1..`; `set --` does.
function withPositionals(script: string, args: string[]): string {
  if (args.length === 0) return script;
  const quoted = args.map((arg): string => `'${arg.replaceAll("'", "'\\''")}'`);

  return `set -- ${quoted.join(" ")}\n${script}`;
}
