import type { SandboxExecAnswer } from "../../core/src/shared/domain/sandbox-config.ts";

export interface WorkerExecRequest {
  script: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  outputLimitBytes: number;
  enableInternet: boolean;
  persist: boolean;
}

export interface RuntimeExecResult {
  result: Omit<SandboxExecAnswer, "duration_ms">;
  /** The disk after the command as R2 stores it; null when it is empty. */
  state: Uint8Array | null | "unchanged";
}
