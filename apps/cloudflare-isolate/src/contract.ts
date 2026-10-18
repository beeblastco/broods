/**
 * What the host Worker and the runtime inside each isolate say to each other,
 * and what core sends the host. Shared by both builds, so a field added on one
 * side fails the other's `check`.
 */

import type { SandboxExecAnswer } from "../../core/src/shared/domain/sandbox-config.ts";

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

/** One finished command, as core's exec contract; the host measures `duration_ms`. */
export type ExecResult = SandboxExecAnswer;

/**
 * The runtime's answer: the result, and the disk after the command as the
 * bytes R2 stores, null for an empty disk, or "unchanged" when the command
 * left the disk as it found it.
 */
export interface RuntimeExecResult {
  result: Omit<ExecResult, "duration_ms">;
  state: Uint8Array | null | "unchanged";
}
