/**
 * Sandbox execution contracts.
 *
 * The sandbox is a single uniform Linux compute backend (real bash + python3 +
 * node on PATH). All providers expose ONE `run` method that executes a piece of
 * code in a (optionally namespaced/persistent) workspace. The harness tools
 * (bash/read/write/edit/glob/grep) all compile down to a bash `code` string —
 * per-runtime routing no longer exists.
 */

export type SandboxProvider = "lambda" | "e2b" | "daytona" | "kubernetes";
export type SandboxRuntime = "bash" | "python" | "node";

// Runtime subset of the persisted sandbox config (see storage/sandbox-config.ts)
// that an executor needs. `internet` selects the lambda internet-on/off function.
export interface SandboxExecutorConfig {
  provider?: SandboxProvider;
  runtimes?: SandboxRuntime[];
  internet?: boolean;
  timeout?: number;
  memoryLimit?: number;
  outputLimitBytes?: number;
  // Account-configured env vars injected into every run.
  envVars?: Record<string, string>;
  // Provider-specific knobs (function names, templates, kubeconfig, ...).
  options?: Record<string, unknown>;
}

export interface SandboxRunRequest {
  // Defaults to "bash". The harness only ever sends "bash"; python/node exist for
  // the lambda API's typed-runtime fidelity.
  runtime?: SandboxRuntime;
  code: string;
  // Persistent workspace namespace. Omit for an ephemeral (no-mount) run.
  namespace?: string;
  workspaceRoot?: string;
  timeoutSeconds: number;
  outputLimitBytes: number;
  args?: string[];
  // Per-call env vars merged over the account-configured envVars. Reserved runtime
  // vars always win and the host process.env is never inherited.
  envVars?: Record<string, string>;
}

export interface SandboxRunResult {
  ok: boolean;
  runtime: SandboxRuntime;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut?: boolean;
  truncated?: boolean;
  provider: SandboxProvider;
}

export interface SandboxExecutor {
  run(request: SandboxRunRequest): Promise<SandboxRunResult>;
}
