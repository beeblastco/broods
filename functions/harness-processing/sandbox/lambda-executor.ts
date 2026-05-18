/**
 * Lambda-backed workspace sandbox executor.
 * Keep AWS child-function invocation here.
 */

import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { optionalEnv } from "../../_shared/env.ts";
import type {
  WorkspaceSandboxConfig,
  WorkspaceSandboxExecutor,
  WorkspaceSandboxRunRequest,
  WorkspaceSandboxRunResult,
} from "./types.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class LambdaWorkspaceSandboxExecutor implements WorkspaceSandboxExecutor {
  readonly #config: WorkspaceSandboxConfig;
  readonly #lambda: LambdaClient;

  constructor(config: WorkspaceSandboxConfig, lambda = new LambdaClient({ region: process.env.AWS_REGION })) {
    this.#config = config;
    this.#lambda = lambda;
  }

  async runFile(request: WorkspaceSandboxRunRequest): Promise<WorkspaceSandboxRunResult> {
    const response = await this.#lambda.send(new InvokeCommand({
      FunctionName: this.functionNameFor(request.runtime),
      InvocationType: "RequestResponse",
      Payload: textEncoder.encode(JSON.stringify(request)),
    }));

    const payloadText = response.Payload ? textDecoder.decode(response.Payload) : "";
    if (response.FunctionError) {
      throw new Error(`Sandbox Lambda failed: ${payloadText || response.FunctionError}`);
    }

    const result = parseSandboxResponse(payloadText);
    return {
      ...result,
      provider: "lambda",
    };
  }

  private functionNameFor(runtime: WorkspaceSandboxRunRequest["runtime"]): string {
    const options = isRecordObject(this.#config.options) ? this.#config.options : {};
    if (runtime === "python") {
      return configString(options.pythonFunctionName) ??
        optionalEnv("SANDBOX_PYTHON_FUNCTION_NAME") ??
        missingFunctionName("python");
    }

    return configString(options.nodeFunctionName) ??
      optionalEnv("SANDBOX_NODE_FUNCTION_NAME") ??
      missingFunctionName("node");
  }
}

function parseSandboxResponse(payloadText: string): Omit<WorkspaceSandboxRunResult, "provider"> {
  if (!payloadText) {
    throw new Error("Sandbox Lambda returned an empty response");
  }

  try {
    const parsed = JSON.parse(payloadText);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Sandbox Lambda response must be an object");
    }
    return parsed as Omit<WorkspaceSandboxRunResult, "provider">;
  } catch (err) {
    throw new Error(`Sandbox Lambda returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function configString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function missingFunctionName(runtime: "node" | "python"): never {
  throw new Error(
    `Workspace sandbox ${runtime} Lambda is not configured. Set config.workspace.sandbox.options.${runtime}FunctionName or SANDBOX_${runtime.toUpperCase()}_FUNCTION_NAME.`,
  );
}
