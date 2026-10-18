/**
 * What the host Worker and the runtime inside each isolate say to each other,
 * and what core sends the host. Shared by both builds, so a field added on one
 * side fails the other's `check`.
 */

import type { SandboxExecResponse } from "../../core/src/shared/domain/sandbox-config.ts";

/** One command from core, after the host validated it. */
export interface IsolateExecRequest {
  /** A bash script, run as `bash -c` would with `args` as its positionals. */
  script: string;
  args: string[];
  /** Created if missing; the script starts in it. */
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  outputLimitBytes: number;
  enableInternet: boolean;
  /** True keeps the files between calls under the sandbox id; false runs on an empty disk. */
  persist: boolean;
}

/**
 * One finished command, its output capped at the request's limit per stream:
 * core's `SandboxExecResponse` (the sandbox exec contract), so core reads it
 * with the parser every exec server goes through.
 */
export type ExecResult = Required<
  Pick<
    SandboxExecResponse,
    | "duration_ms"
    | "exit_code"
    | "ok"
    | "stderr"
    | "stdout"
    | "timed_out"
    | "truncated"
  >
>;

/** The runtime's answer: the result and the files after it, compressed, or null for an empty disk. */
export interface RuntimeExecResult {
  result: ExecResult;
  state: Uint8Array | null;
}
