/**
 * E2B-backed sandbox executor.
 * Keep E2B SDK adaptation here. A real VM: run the bash `code` as-is in the
 * workspace directory — no emulation and no per-runtime routing.
 */

import { optionalEnv } from "../../_shared/env.ts";
import { Sandbox } from "e2b";
import type {
  SandboxExecutor,
  SandboxExecutorConfig,
  SandboxRunRequest,
  SandboxRunResult,
} from "./types.ts";
import { configString, isRecordObject, stringRecord, truncateText, workspacePath } from "./utils.ts";

export class E2BSandboxExecutor implements SandboxExecutor {
  readonly #config: SandboxExecutorConfig;

  constructor(config: SandboxExecutorConfig) {
    this.#config = config;
  }

  async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    const startedAt = Date.now();
    const sandbox = await Sandbox.create(e2bCreateOptions(this.#config));
    const cwd = workspacePath(request);

    try {
      const result = await sandbox.commands.run(request.code, {
        ...(cwd ? { cwd } : {}),
        timeoutMs: request.timeoutSeconds * 1000,
        // Account-configured env vars merged with per-call vars. E2B already
        // isolates from the harness host env.
        envs: { ...stringRecord(this.#config.envVars), ...(request.envVars ?? {}) },
      });
      const stdout = truncateText(result.stdout ?? "", request.outputLimitBytes);
      const stderr = truncateText([result.stderr, result.error].filter(Boolean).join("\n"), request.outputLimitBytes);
      return {
        ok: (result.exitCode ?? null) === 0,
        runtime: request.runtime ?? "bash",
        exitCode: result.exitCode ?? null,
        stdout: stdout.value,
        stderr: stderr.value,
        durationMs: Date.now() - startedAt,
        truncated: stdout.truncated || stderr.truncated,
        provider: "e2b",
      };
    } finally {
      await sandbox.kill();
    }
  }
}

function e2bCreateOptions(config: SandboxExecutorConfig): Record<string, unknown> {
  const options = isRecordObject(config.options) ? config.options : {};
  return {
    ...(configString(options.apiKey) ?? optionalEnv("E2B_API_KEY")
      ? { apiKey: configString(options.apiKey) ?? optionalEnv("E2B_API_KEY") }
      : {}),
    ...(configString(options.template) ? { template: configString(options.template) } : {}),
    ...(configString(options.templateId) ? { template: configString(options.templateId) } : {}),
  };
}
