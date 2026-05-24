/**
 * Workspace sandbox execution contracts.
 * Keep provider-neutral file execution shapes here.
 */

export type WorkspaceSandboxProvider = "lambda" | "e2b" | "daytona";
export type WorkspaceSandboxRuntime = "node" | "python";

export interface WorkspaceSandboxConfig {
  enabled?: boolean;
  provider?: WorkspaceSandboxProvider;
  timeout?: number;
  memoryLimit?: number;
  outputLimitBytes?: number;
  filesystem?: {
    mount?: "native";
  };
  options?: Record<string, unknown>;
}

export interface WorkspaceSandboxArtifact {
  kind: "file" | "image" | "chart" | "unknown";
  path?: string;
  mediaType?: string;
  title?: string;
  dataBase64?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkspaceSandboxRunRequest {
  runtime: WorkspaceSandboxRuntime;
  namespace: string;
  entryPath: string;
  args: string[];
  workspaceRoot: string;
  timeoutSeconds: number;
  outputLimitBytes: number;
}

export interface WorkspaceSandboxRunResult {
  ok: boolean;
  runtime: WorkspaceSandboxRuntime;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  artifacts?: WorkspaceSandboxArtifact[];
  durationMs: number;
  timedOut?: boolean;
  truncated?: boolean;
  provider: WorkspaceSandboxProvider;
}

export interface WorkspaceSandboxExecutor {
  runFile(request: WorkspaceSandboxRunRequest): Promise<WorkspaceSandboxRunResult>;
}
