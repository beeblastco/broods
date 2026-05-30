/**
 * Daytona-backed workspace sandbox executor.
 * Keep Daytona SDK adaptation here.
 */

import { optionalEnv } from "../../_shared/env.ts";
import { WORKSPACE_MOUNT_PREFIX } from "../../_shared/sandbox.ts";
import { Daytona, type Sandbox } from "@daytona/sdk";
import type {
  WorkspaceSandboxArtifact,
  WorkspaceSandboxConfig,
  WorkspaceSandboxExecutor,
  WorkspaceSandboxRunRequest,
  WorkspaceSandboxRunResult,
  WorkspaceSandboxRuntime,
  WorkspaceSandboxShellRequest,
  WorkspaceSandboxShellResult,
} from "./types.ts";

export class DaytonaWorkspaceSandboxExecutor implements WorkspaceSandboxExecutor {
  readonly #config: WorkspaceSandboxConfig;

  constructor(config: WorkspaceSandboxConfig) {
    this.#config = config;
  }

  async runFile(request: WorkspaceSandboxRunRequest): Promise<WorkspaceSandboxRunResult> {
    const startedAt = Date.now();
    const client = new Daytona(daytonaClientOptions(this.#config));
    const sandbox = await client.create(daytonaCreateOptions(this.#config, request.runtime));

    try {
      await mountAwsS3Buckets(sandbox, request, this.#config);
      const response = await sandbox.process.executeCommand(
        commandForFile(request),
        workspacePath(request),
        undefined,
        request.timeoutSeconds,
      );
      const stdout = response.result ?? artifactStdout(response.artifacts);
      const stderr = "";
      const truncatedStdout = truncateText(stdout, request.outputLimitBytes);
      const truncatedStderr = truncateText(stderr, request.outputLimitBytes);
      return {
        ok: (response.exitCode ?? 0) === 0,
        runtime: request.runtime,
        exitCode: response.exitCode ?? null,
        stdout: truncatedStdout.value,
        stderr: truncatedStderr.value,
        artifacts: normalizeArtifacts(response.artifacts),
        durationMs: Date.now() - startedAt,
        truncated: truncatedStdout.truncated || truncatedStderr.truncated,
        provider: "daytona",
      };
    } finally {
      await sandbox.delete();
    }
  }

  // A real VM: mount the workspace, then run the command as-is. No emulation and
  // no per-runtime routing — bash, node, python, etc. are all on the PATH.
  async runShell(request: WorkspaceSandboxShellRequest): Promise<WorkspaceSandboxShellResult> {
    const startedAt = Date.now();
    const client = new Daytona(daytonaClientOptions(this.#config));
    const sandbox = await client.create(daytonaCreateOptions(this.#config));

    try {
      await mountAwsS3Buckets(sandbox, request, this.#config);
      const response = await sandbox.process.executeCommand(
        request.shell,
        workspacePath(request),
        undefined,
        request.timeoutSeconds,
      );
      const stdout = truncateText(response.result ?? artifactStdout(response.artifacts), request.outputLimitBytes);
      return {
        ok: (response.exitCode ?? 0) === 0,
        exitCode: response.exitCode ?? null,
        stdout: stdout.value,
        stderr: "",
        durationMs: Date.now() - startedAt,
        truncated: stdout.truncated,
        provider: "daytona",
      };
    } finally {
      await sandbox.delete();
    }
  }
}

function commandForFile(request: WorkspaceSandboxRunRequest): string {
  const executable = request.runtime === "node" ? "node" : "python3";
  return [executable, entryRelativePath(request.entryPath), ...request.args].map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function daytonaClientOptions(config: WorkspaceSandboxConfig): Record<string, unknown> {
  const options = isRecordObject(config.options) ? config.options : {};
  return {
    ...(configString(options.apiKey) ?? optionalEnv("DAYTONA_API_KEY")
      ? { apiKey: configString(options.apiKey) ?? optionalEnv("DAYTONA_API_KEY") }
      : {}),
    ...(configString(options.organizationId) ?? optionalEnv("DAYTONA_ORGANIZATION_ID")
      ? { organizationId: configString(options.organizationId) ?? optionalEnv("DAYTONA_ORGANIZATION_ID") }
      : {}),
    ...(configString(options.apiUrl) ?? optionalEnv("DAYTONA_API_URL")
      ? { apiUrl: configString(options.apiUrl) ?? optionalEnv("DAYTONA_API_URL") }
      : {}),
    ...(configString(options.target) ?? optionalEnv("DAYTONA_TARGET")
      ? { target: configString(options.target) ?? optionalEnv("DAYTONA_TARGET") }
      : {}),
  };
}

function daytonaCreateOptions(
  config: WorkspaceSandboxConfig,
  runtime?: WorkspaceSandboxRuntime,
): Record<string, unknown> {
  const options = isRecordObject(config.options) ? config.options : {};
  const envVars = daytonaEnvVars(isStringRecord(config.envVars) ? config.envVars : {}, options);
  return {
    language: runtime === "python" ? "python" : "typescript",
    ...(configString(options.snapshot) ? { snapshot: configString(options.snapshot) } : {}),
    ...(configString(options.image) ? { image: configString(options.image) } : {}),
    ...(Object.keys(envVars).length > 0 ? { envVars } : {}),
    ...(typeof options.networkBlockAll === "boolean" ? { networkBlockAll: options.networkBlockAll } : {}),
    ...(configString(options.networkAllowList) ? { networkAllowList: configString(options.networkAllowList) } : {}),
  };
}

function daytonaEnvVars(userEnv: Record<string, string>, options: Record<string, unknown>): Record<string, string> {
  const envVars = { ...userEnv };
  if (options.mountAwsS3Buckets !== true) {
    return envVars;
  }

  const credentials = awsCredentialEnvVars(envVars);
  const region = configString(options.awsRegion) ?? optionalEnv("AWS_REGION") ?? optionalEnv("AWS_DEFAULT_REGION");
  return {
    ...envVars,
    ...credentials,
    ...(region ? { AWS_REGION: region, AWS_DEFAULT_REGION: region } : {}),
  };
}

function awsCredentialEnvVars(envVars: Record<string, string>): Record<string, string> {
  const accessKeyId = envVars.AWS_ACCESS_KEY_ID ?? optionalEnv("AWS_ACCESS_KEY_ID");
  const secretAccessKey = envVars.AWS_SECRET_ACCESS_KEY ?? optionalEnv("AWS_SECRET_ACCESS_KEY");
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "Daytona AWS S3 mounts require AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in the harness runtime or config.workspace.sandbox.envVars.",
    );
  }

  return {
    AWS_ACCESS_KEY_ID: accessKeyId,
    AWS_SECRET_ACCESS_KEY: secretAccessKey,
    ...(envVars.AWS_SESSION_TOKEN ?? optionalEnv("AWS_SESSION_TOKEN")
      ? { AWS_SESSION_TOKEN: envVars.AWS_SESSION_TOKEN ?? optionalEnv("AWS_SESSION_TOKEN")! }
      : {}),
  };
}

async function mountAwsS3Buckets(
  sandbox: Sandbox,
  request: { workspaceRoot: string },
  config: WorkspaceSandboxConfig,
): Promise<void> {
  const options = isRecordObject(config.options) ? config.options : {};
  if (options.mountAwsS3Buckets !== true) {
    return;
  }

  const workspaceBucketName = configString(options.workspaceBucketName) ?? optionalEnv("FILESYSTEM_BUCKET_NAME");
  if (!workspaceBucketName) {
    throw new Error(
      "Daytona AWS S3 workspace mount requires config.workspace.sandbox.options.workspaceBucketName or FILESYSTEM_BUCKET_NAME.",
    );
  }

  const workspaceRoot = request.workspaceRoot.replace(/\/+$/, "");
  // Mount only the workspace key prefix so paths line up with the harness and the
  // Lambda provider's S3 Files access point (see workspaceNamespacePrefix).
  await mountS3Bucket(sandbox, workspaceBucketName, workspaceRoot, options, `${WORKSPACE_MOUNT_PREFIX}/`);

  const skillsBucketName = configString(options.skillsBucketName) ?? optionalEnv("SKILLS_BUCKET_NAME");
  if (!skillsBucketName) {
    return;
  }

  const skillsMountPath = configString(options.skillsMountPath) ?? "/mnt/skills";
  await mountS3Bucket(sandbox, skillsBucketName, skillsMountPath, options);
}

/**
 * Mouts an S3 bucket to the sandbox.
 * Currently provide full execution permissions
 */
async function mountS3Bucket(
  sandbox: Sandbox,
  bucketName: string,
  mountPath: string,
  options: Record<string, unknown>,
  keyPrefix?: string,
): Promise<void> {
  await executeDaytonaSetupCommand(sandbox, `sudo mkdir -p ${shellQuote(mountPath)}`);
  await executeDaytonaSetupCommand(sandbox, `sudo chown "$(id -u)":"$(id -g)" ${shellQuote(mountPath)}`);
  const mountArgs = [
    "--allow-delete",
    "--allow-overwrite",
    "--allow-other",
    ...(keyPrefix ? ["--prefix", keyPrefix] : []),
    ...mountRegionArgs(options),
    bucketName,
    mountPath,
  ].map(shellQuote).join(" ");
  await executeDaytonaSetupCommand(
    sandbox,
    `sudo -E mount-s3 --uid "$(id -u)" --gid "$(id -g)" ${mountArgs}`,
  );
}

function mountRegionArgs(options: Record<string, unknown>): string[] {
  const region = configString(options.awsRegion) ?? optionalEnv("AWS_REGION") ?? optionalEnv("AWS_DEFAULT_REGION");
  return region ? ["--region", region] : [];
}

async function executeDaytonaSetupCommand(sandbox: Sandbox, command: string): Promise<void> {
  const response = await sandbox.process.executeCommand(command);
  if ((response.exitCode ?? 0) !== 0) {
    throw new Error(`Daytona setup command failed: ${command}\n${response.result ?? ""}`);
  }
}

function configString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecordObject(value) &&
    Object.values(value).every((entry) => typeof entry === "string");
}

function workspacePath(request: { workspaceRoot: string; namespace: string }): string {
  return `${request.workspaceRoot.replace(/\/+$/, "")}/${request.namespace}`;
}

function entryRelativePath(path: string): string {
  return path.replace(/^\/+/, "");
}

function artifactStdout(artifacts: unknown): string {
  return isRecordObject(artifacts) && typeof artifacts.stdout === "string" ? artifacts.stdout : "";
}

function normalizeArtifacts(artifacts: unknown): WorkspaceSandboxArtifact[] {
  if (!isRecordObject(artifacts)) {
    return [];
  }

  const charts = Array.isArray(artifacts.charts) ? artifacts.charts : [];
  return charts.map((chart) => ({
    kind: "chart",
    metadata: isRecordObject(chart) ? chart : { value: chart },
  }));
}

function truncateText(value: string, limit: number): { value: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= limit) {
    return { value, truncated: false };
  }

  return {
    value: `${new TextDecoder().decode(bytes.slice(0, limit))}\n[output truncated]`,
    truncated: true,
  };
}
