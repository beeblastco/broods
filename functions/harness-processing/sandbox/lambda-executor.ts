/**
 * Lambda-backed sandbox executor.
 * Invokes the uniform lambda-sandbox container image (real bash/python3/node).
 *
 * Four functions of the same image are deployed across two axes (workspace mount
 * vs none, internet on vs off). The function is auto-selected per run from
 * (namespace present? => mounted) and the configured `internet` flag, via four
 * env vars set by SST (SANDBOX_FN_{MOUNT,NOMOUNT}_{NET,NONET}).
 */

import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { optionalEnv } from "../../_shared/env.ts";
import type {
  SandboxExecutor,
  SandboxExecutorConfig,
  SandboxRunRequest,
  SandboxRunResult,
} from "./types.ts";
import { stringRecord, truncateText } from "./utils.ts";

interface SandboxResponse {
  ok: boolean;
  runtime?: string;
  exit_code?: number | null;
  timed_out: boolean;
  duration_ms: number;
  stdout: string;
  stderr: string;
  truncated?: boolean;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const FUNCTION_ENV_VARS: Record<FunctionSlot, string> = {
  mountNet: "SANDBOX_FN_MOUNT_NET",
  mountNoNet: "SANDBOX_FN_MOUNT_NONET",
  noMountNet: "SANDBOX_FN_NOMOUNT_NET",
  noMountNoNet: "SANDBOX_FN_NOMOUNT_NONET",
};

type FunctionSlot = "mountNet" | "mountNoNet" | "noMountNet" | "noMountNoNet";

export class LambdaSandboxExecutor implements SandboxExecutor {
  readonly #config: SandboxExecutorConfig;
  readonly #lambda: LambdaClient;

  constructor(config: SandboxExecutorConfig, lambda = new LambdaClient({ region: process.env.AWS_REGION })) {
    this.#config = config;
    this.#lambda = lambda;
  }

  async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    const runtime = request.runtime ?? "bash";
    const hasWorkspace = typeof request.namespace === "string" && request.namespace.length > 0;
    const internet = this.#config.internet === true;

    const response = await this.#invoke(this.#functionName(hasWorkspace, internet), {
      runtime,
      code: request.code,
      ...(hasWorkspace ? { namespace: request.namespace } : {}),
      ...(request.workspaceRoot ? { workspace_root: request.workspaceRoot } : {}),
      timeout_ms: request.timeoutSeconds * 1000,
      ...(request.args && request.args.length > 0 ? { args: request.args } : {}),
      env: this.#sandboxEnvVars(request.envVars),
    });
    const stdout = truncateText(response.stdout, request.outputLimitBytes);
    const stderr = truncateText(response.stderr, request.outputLimitBytes);

    return {
      ok: response.ok,
      runtime,
      exitCode: response.exit_code ?? null,
      stdout: stdout.value,
      stderr: stderr.value,
      durationMs: response.duration_ms,
      timedOut: response.timed_out,
      truncated: response.truncated === true || stdout.truncated || stderr.truncated,
      provider: "lambda",
    };
  }

  #functionName(hasWorkspace: boolean, internet: boolean): string {
    const slot: FunctionSlot = hasWorkspace
      ? (internet ? "mountNet" : "mountNoNet")
      : (internet ? "noMountNet" : "noMountNoNet");

    const name = optionalEnv(FUNCTION_ENV_VARS[slot]);
    if (!name) {
      throw new Error(
        `Sandbox lambda function for slot "${slot}" is not configured. ` +
          `Set ${FUNCTION_ENV_VARS[slot]}.`,
      );
    }
    return name;
  }

  #sandboxEnvVars(requestEnvVars?: Record<string, string>): Record<string, string> {
    return { ...stringRecord(this.#config.envVars), ...(requestEnvVars ?? {}) };
  }

  async #invoke(functionName: string, payload: object): Promise<SandboxResponse> {
    const response = await this.#lambda.send(new InvokeCommand({
      FunctionName: functionName,
      InvocationType: "RequestResponse",
      Payload: textEncoder.encode(JSON.stringify(payload)),
    }));

    const payloadText = response.Payload ? textDecoder.decode(response.Payload) : "";
    if (response.FunctionError) {
      throw new Error(`Sandbox Lambda failed: ${payloadText || response.FunctionError}`);
    }

    if (!payloadText) {
      throw new Error("Sandbox Lambda returned an empty response");
    }

    const parsed = JSON.parse(payloadText);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Sandbox Lambda response must be an object");
    }
    return parsed as SandboxResponse;
  }
}
