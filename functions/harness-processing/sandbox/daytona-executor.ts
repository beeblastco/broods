/**
 * Daytona-backed sandbox executor.
 * Keep Daytona SDK adaptation here. A real VM: mount the workspace, then run the
 * bash `code` as-is — no emulation and no per-runtime routing.
 */

import { optionalEnv } from "../../_shared/env.ts";
import { WORKSPACE_MOUNT_PREFIX } from "../../_shared/sandbox.ts";
import { Daytona, type Sandbox } from "@daytona/sdk";
import type {
  SandboxExecutor,
  SandboxExecutorConfig,
  SandboxRunRequest,
  SandboxRunResult,
} from "./types.ts";
import {
  configString,
  isRecordObject,
  isStringRecord,
  shellQuote,
  truncateText,
  workspacePath,
} from "./utils.ts";

export class DaytonaSandboxExecutor implements SandboxExecutor {
  readonly #config: SandboxExecutorConfig;

  constructor(config: SandboxExecutorConfig) {
    this.#config = config;
  }

  async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    const startedAt = Date.now();
    const client = new Daytona(daytonaClientOptions(this.#config));
    const sandbox = await client.create(daytonaCreateOptions(this.#config, request.envVars));

    try {
      await mountAwsS3Buckets(sandbox, request, this.#config);
      const response = await sandbox.process.executeCommand(
        request.code,
        workspacePath(request),
        undefined,
        request.timeoutSeconds,
      );
      const stdout = truncateText(response.result ?? artifactStdout(response.artifacts), request.outputLimitBytes);
      return {
        ok: (response.exitCode ?? 0) === 0,
        runtime: request.runtime ?? "bash",
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

function daytonaClientOptions(config: SandboxExecutorConfig): Record<string, unknown> {
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
  config: SandboxExecutorConfig,
  requestEnvVars?: Record<string, string>,
): Record<string, unknown> {
  const options = isRecordObject(config.options) ? config.options : {};
  const baseEnv = { ...(isStringRecord(config.envVars) ? config.envVars : {}), ...(requestEnvVars ?? {}) };
  const envVars = daytonaEnvVars(baseEnv, options);
  return {
    language: "typescript",
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
      "Daytona AWS S3 mounts require AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in the harness runtime or sandbox envVars.",
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
  request: { workspaceRoot?: string; namespace?: string },
  config: SandboxExecutorConfig,
): Promise<void> {
  const options = isRecordObject(config.options) ? config.options : {};
  if (options.mountAwsS3Buckets !== true) {
    return;
  }

  const workspaceBucketName = configString(options.workspaceBucketName) ?? optionalEnv("FILESYSTEM_BUCKET_NAME");
  if (!workspaceBucketName) {
    throw new Error(
      "Daytona AWS S3 workspace mount requires config.options.workspaceBucketName or FILESYSTEM_BUCKET_NAME.",
    );
  }
  if (!request.namespace) {
    throw new Error("Daytona AWS S3 workspace mount requires a workspace namespace.");
  }

  const workspaceRoot = (request.workspaceRoot ?? "/mnt/workspaces").replace(/\/+$/, "");
  const workspaceMountPath = `${workspaceRoot}/${request.namespace}`;
  // Mount only the workspace key prefix so paths line up with the harness and the
  // Lambda provider's S3 Files access point (see workspaceNamespacePrefix).
  await mountS3Bucket(
    sandbox,
    workspaceBucketName,
    workspaceMountPath,
    options,
    `${WORKSPACE_MOUNT_PREFIX}/${request.namespace}/`,
  );

  const skillsBucketName = configString(options.skillsBucketName) ?? optionalEnv("SKILLS_BUCKET_NAME");
  if (!skillsBucketName) {
    return;
  }

  const skillsMountPath = configString(options.skillsMountPath) ?? "/mnt/skills";
  await mountS3Bucket(sandbox, skillsBucketName, skillsMountPath, options);
}

/**
 * Mounts an S3 bucket into the sandbox with full read/write permissions.
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

function artifactStdout(artifacts: unknown): string {
  return isRecordObject(artifacts) && typeof artifacts.stdout === "string" ? artifacts.stdout : "";
}
