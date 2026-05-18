/**
 * Daytona-backed workspace sandbox executor.
 * Keep Daytona SDK adaptation here.
 */

import { optionalEnv } from "../../_shared/env.ts";
import { Daytona } from "@daytona/sdk";
import type {
  WorkspaceSandboxArtifact,
  WorkspaceSandboxConfig,
  WorkspaceSandboxExecutor,
  WorkspaceSandboxRunRequest,
  WorkspaceSandboxRunResult,
} from "./types.ts";

export class DaytonaWorkspaceSandboxExecutor implements WorkspaceSandboxExecutor {
  readonly #config: WorkspaceSandboxConfig;

  constructor(config: WorkspaceSandboxConfig) {
    this.#config = config;
  }

  async runFile(request: WorkspaceSandboxRunRequest): Promise<WorkspaceSandboxRunResult> {
    const startedAt = Date.now();
    const client = new Daytona(daytonaClientOptions(this.#config));
    const sandbox = await client.create(daytonaCreateOptions(request, this.#config));

    try {
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
    ...(configString(options.apiUrl) ?? optionalEnv("DAYTONA_API_URL")
      ? { apiUrl: configString(options.apiUrl) ?? optionalEnv("DAYTONA_API_URL") }
      : {}),
    ...(configString(options.target) ?? optionalEnv("DAYTONA_TARGET")
      ? { target: configString(options.target) ?? optionalEnv("DAYTONA_TARGET") }
      : {}),
  };
}

function daytonaCreateOptions(
  request: WorkspaceSandboxRunRequest,
  config: WorkspaceSandboxConfig,
): Record<string, unknown> {
  const options = isRecordObject(config.options) ? config.options : {};
  return {
    language: request.runtime === "python" ? "python" : "typescript",
    ...(configString(options.image) ? { image: configString(options.image) } : {}),
    ...(isRecordObject(options.envVars) ? { envVars: options.envVars } : {}),
  };
}

function configString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function workspacePath(request: WorkspaceSandboxRunRequest): string {
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
