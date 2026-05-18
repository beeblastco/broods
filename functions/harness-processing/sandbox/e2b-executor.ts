/**
 * E2B-backed workspace sandbox executor.
 * Keep E2B SDK adaptation here.
 */

import { optionalEnv } from "../../_shared/env.ts";
import { Sandbox } from "e2b";
import type {
  WorkspaceSandboxConfig,
  WorkspaceSandboxExecutor,
  WorkspaceSandboxRunRequest,
  WorkspaceSandboxRunResult,
} from "./types.ts";

export class E2BWorkspaceSandboxExecutor implements WorkspaceSandboxExecutor {
  readonly #config: WorkspaceSandboxConfig;

  constructor(config: WorkspaceSandboxConfig) {
    this.#config = config;
  }

  async runFile(request: WorkspaceSandboxRunRequest): Promise<WorkspaceSandboxRunResult> {
    const startedAt = Date.now();
    const sandbox = await Sandbox.create(e2bCreateOptions(this.#config));

    try {
      await sandbox.files.write(request.entry.path, request.entry.content);
      const result = await sandbox.commands.run(request.command, {
        cwd: dirname(request.entry.path),
        timeoutMs: request.timeoutSeconds * 1000,
      });
      return formatResult({
        runtime: request.runtime,
        provider: "e2b",
        startedAt,
        exitCode: result.exitCode ?? null,
        stdout: result.stdout ?? "",
        stderr: [result.stderr, result.error].filter(Boolean).join("\n"),
        outputLimitBytes: request.outputLimitBytes,
      });
    } finally {
      await sandbox.kill();
    }
  }
}

function formatResult(params: {
  runtime: WorkspaceSandboxRunRequest["runtime"];
  provider: "e2b";
  startedAt: number;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputLimitBytes: number;
}): WorkspaceSandboxRunResult {
  const truncatedStdout = truncateText(params.stdout, params.outputLimitBytes);
  const truncatedStderr = truncateText(params.stderr, params.outputLimitBytes);
  return {
    ok: params.exitCode === 0,
    runtime: params.runtime,
    exitCode: params.exitCode,
    stdout: truncatedStdout.value,
    stderr: truncatedStderr.value,
    durationMs: Date.now() - params.startedAt,
    truncated: truncatedStdout.truncated || truncatedStderr.truncated,
    provider: params.provider,
  };
}

function e2bCreateOptions(config: WorkspaceSandboxConfig): Record<string, unknown> {
  const options = isRecordObject(config.options) ? config.options : {};
  return {
    ...(configString(options.apiKey) ?? optionalEnv("E2B_API_KEY")
      ? { apiKey: configString(options.apiKey) ?? optionalEnv("E2B_API_KEY") }
      : {}),
    ...(configString(options.template) ? { template: configString(options.template) } : {}),
    ...(configString(options.templateId) ? { template: configString(options.templateId) } : {}),
  };
}

function configString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function dirname(path: string): string {
  return path.slice(0, path.lastIndexOf("/")) || "/";
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
