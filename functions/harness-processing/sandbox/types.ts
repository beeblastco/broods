/**
 * Workspace sandbox execution contracts.
 * Keep provider-neutral file execution shapes here.
 */

export type WorkspaceSandboxProvider = "lambda" | "e2b" | "daytona";
export type WorkspaceSandboxRuntime = "node" | "python";

export interface WorkspaceSandboxConfig {
  provider?: WorkspaceSandboxProvider;
  timeout?: number;
  memoryLimit?: number;
  outputLimitBytes?: number;
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

export interface WorkspaceSandboxShellRequest {
  namespace: string;
  shell: string;
  workspaceRoot: string;
  timeoutSeconds: number;
  outputLimitBytes: number;
}

export interface WorkspaceSandboxReadDirRequest {
  namespace: string;
  // Path relative to the namespace mount root, e.g. ".claude/skills/<name>".
  path: string;
  workspaceRoot: string;
  maxBytes?: number;
}

export interface WorkspaceSandboxReadDirFile {
  // Path relative to the requested directory, e.g. "SKILL.md" or "scripts/run.py".
  path: string;
  base64: string;
}

export interface WorkspaceSandboxReadDirResult {
  ok: boolean;
  files: WorkspaceSandboxReadDirFile[];
  truncated?: boolean;
  error?: string;
  provider: WorkspaceSandboxProvider;
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

export interface WorkspaceSandboxShellResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut?: boolean;
  truncated?: boolean;
  provider: WorkspaceSandboxProvider;
}

export interface WorkspaceSandboxExecutor {
  runFile(request: WorkspaceSandboxRunRequest): Promise<WorkspaceSandboxRunResult>;
  runShell?(request: WorkspaceSandboxShellRequest): Promise<WorkspaceSandboxShellResult>;
  // Reads a directory's files straight from the mount. Required for publishing skill
  // edits: files the agent wrote through the mount are not visible to a direct S3 read
  // for ~1-2 min (S3 Files syncs asynchronously), so publish must read the mount.
  readDirectory?(request: WorkspaceSandboxReadDirRequest): Promise<WorkspaceSandboxReadDirResult>;
}
