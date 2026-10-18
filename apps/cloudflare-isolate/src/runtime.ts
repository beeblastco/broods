/**
 * What runs inside each sandbox's isolate: just-bash, a bash written in
 * TypeScript with its own in-memory disk and 81 commands, no processes, no
 * eval. The host Worker loads this module as a Dynamic Worker per sandbox,
 * hands it the stored disk and one command, and takes back the result and
 * the disk after it. Nothing here touches R2 or the network policy: the host
 * owns both.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import {
  Bash,
  type BashExecResult,
  type NetworkConfig,
} from "just-bash/browser";
import type {
  ExecResult,
  IsolateExecRequest,
  RuntimeExecResult,
} from "./contract.ts";
import { MAX_OUTPUT_BYTES } from "./limits.ts";
import { decodeState, emptyFs, encodeState } from "./vfs-state.ts";

// What `curl` may do once the sandbox has internet; the policy is on or off.
// Private-range checks need DNS pinning, which a Worker has no way to do, and
// Cloudflare's own egress reaches no private address anyway.
const INTERNET: NetworkConfig = {
  dangerouslyAllowFullInternetAccess: true,
  allowedMethods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  denyPrivateRanges: false,
};
// What just-bash exits with at its deadline; before it, a `timeout` command's own.
const DEADLINE_EXIT_CODE = 124;

/** The host calls `exec` over RPC; the default export only names the module a Worker. */
export class Runtime extends WorkerEntrypoint {
  async exec(
    request: IsolateExecRequest,
    state: Uint8Array | null,
  ): Promise<RuntimeExecResult> {
    const fs = state === null ? emptyFs() : await decodeState(state);
    await fs.mkdir(request.cwd, { recursive: true });
    const bash = new Bash({
      fs: fs,
      cwd: request.cwd,
      env: request.env,
      executionLimits: {
        maxExecutionTimeMs: request.timeoutMs,
        maxOutputSize: MAX_OUTPUT_BYTES,
      },
      ...(request.enableInternet ? { network: INTERNET } : {}),
    });
    // The clock only advances while the shell waits on something, so the
    // deadline catches a slow command and the isolate's CPU limit a busy one.
    const startedAt = Date.now();
    const pastDeadline = (): boolean =>
      Date.now() - startedAt >= request.timeoutMs;
    const result = await bash
      .exec(withPositionals(request.script, request.args), {
        cwd: request.cwd,
        rawScript: true,
      })
      .then(
        (finished): ExecResult =>
          execResult(
            finished,
            request,
            finished.exitCode === DEADLINE_EXIT_CODE && pastDeadline(),
          ),
        (error: unknown): ExecResult =>
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

    return {
      result: result,
      state: request.persist ? await encodeState(fs) : null,
    };
  }
}

export default {
  fetch: function (): Response {
    return new Response("The isolate runtime answers RPC only", {
      status: 404,
    });
  },
};

// The host measures the call, so `duration_ms` is filled there.
function execResult(
  finished: BashExecResult,
  request: IsolateExecRequest,
  timedOut: boolean,
): ExecResult {
  const stdout = capped(finished.stdout, request.outputLimitBytes);
  const stderr = capped(finished.stderr, request.outputLimitBytes);

  return {
    ok: !timedOut && finished.exitCode === 0,
    exit_code: timedOut ? null : finished.exitCode,
    timed_out: timedOut,
    duration_ms: 0,
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

// Keeps the first `limit` bytes of a stream, whole characters only.
function capped(
  text: string,
  limit: number,
): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= limit) return { text: text, truncated: false };

  return {
    text: new TextDecoder().decode(bytes.subarray(0, limit)),
    truncated: true,
  };
}
