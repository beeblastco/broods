/**
 * The sandbox exec wire contract: what core POSTs to `<endpoint>/exec` and what
 * the server answers. The `lambda` MicroVM image speaks it, and the `custom`
 * provider lets an account point core at its own server that speaks it. The
 * SDK publishes both types so such a server can be written against them.
 * snake_case on purpose: the image shipped it first.
 */

import type { RuntimeName } from "./sandboxRules";

/** One exec, POSTed as JSON to `<endpoint>/exec`. */
export interface SandboxExecRequest {
  /** Which interpreter runs `code`. Core sends `bash`. */
  runtime: RuntimeName;
  code: string;
  /** Workspace namespace; selects the working directory. Absent for a stateless run. */
  namespace?: string;
  /** Root the namespace sits under; the server picks its default when absent. */
  workspace_root?: string;
  /** The server kills the process and answers `timed_out: true` once this passes. */
  timeout_ms: number;
  /** Positional arguments for `code`. */
  args?: string[];
  /** The whole process environment: the server must not add its own. */
  env: Record<string, string>;
}

/** The JSON answer to one exec; HTTP 200 even when the code failed. */
export interface SandboxExecResponse {
  /** False when the process failed, timed out, or the request was invalid. */
  ok: boolean;
  runtime?: string;
  /** Null when the process was killed by the timeout. */
  exit_code?: number | null;
  timed_out: boolean;
  /** Wall-clock time of the exec. */
  duration_ms: number;
  stdout: string;
  stderr: string;
  /** True when the server already cut stdout or stderr. */
  truncated?: boolean;
  /** CPU time of the exec in microseconds, for usage metering. */
  cpu_usec?: number;
  /** The machine's vCPU-s and GB-s above its baseline since boot. MicroVM only. */
  burst?: { vcpu_seconds: number; gb_seconds: number };
}
