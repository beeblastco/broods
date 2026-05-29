/**
 * Lambda-backed workspace sandbox executor.
 * Keep AWS child-function invocation here.
 */

import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { optionalEnv } from "../../_shared/env.ts";
import { ensureS3DirectoryMarkers, writeS3Object } from "../../_shared/s3.ts";
import { workspaceNamespacePrefix } from "../../_shared/sandbox.ts";
import type {
  WorkspaceSandboxConfig,
  WorkspaceSandboxExecutor,
  WorkspaceSandboxArtifact,
  WorkspaceSandboxRunRequest,
  WorkspaceSandboxRunResult,
  WorkspaceSandboxShellRequest,
  WorkspaceSandboxShellResult,
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

    const result = parseSandboxResponse<WorkspaceSandboxRunResult>(payloadText);
    await persistGeneratedFiles(request.namespace, result.artifacts);
    return {
      ...result,
      provider: "lambda",
    };
  }

  async runShell(request: WorkspaceSandboxShellRequest): Promise<WorkspaceSandboxShellResult> {
    const response = await this.#lambda.send(new InvokeCommand({
      FunctionName: this.shellFunctionName(),
      InvocationType: "RequestResponse",
      Payload: textEncoder.encode(JSON.stringify({
        ...request,
        runtime: "shell",
        networkAccess: networkAccessFor(this.#config),
      })),
    }));

    const payloadText = response.Payload ? textDecoder.decode(response.Payload) : "";
    if (response.FunctionError) {
      throw new Error(`Sandbox Bash Lambda failed: ${payloadText || response.FunctionError}`);
    }

    return {
      ...parseSandboxResponse<WorkspaceSandboxShellResult>(payloadText),
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

  private shellFunctionName(): string {
    const options = isRecordObject(this.#config.options) ? this.#config.options : {};
    return configString(options.bashFunctionName) ??
      optionalEnv("SANDBOX_BASH_FUNCTION_NAME") ??
      missingFunctionName("bash");
  }
}

async function persistGeneratedFiles(namespace: string, artifacts: WorkspaceSandboxArtifact[] | undefined): Promise<void> {
  const bucket = optionalEnv("FILESYSTEM_BUCKET_NAME");
  if (!bucket || !artifacts?.length) {
    return;
  }

  for (const artifact of artifacts) {
    if (artifact.kind !== "file" || !artifact.path || !artifact.dataBase64) {
      continue;
    }

    const key = toStorageKey(namespace, artifact.path);
    const body = Uint8Array.from(Buffer.from(artifact.dataBase64, "base64"));
    await ensureS3DirectoryMarkers(bucket, key);
    await writeS3Object(bucket, key, body, {
      contentType: artifact.mediaType,
    });
  }
}

function toStorageKey(namespace: string, artifactPath: string): string {
  const normalizedPath = artifactPath.startsWith("/") ? artifactPath.slice(1) : artifactPath;
  if (
    !normalizedPath ||
    normalizedPath.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Sandbox Lambda returned invalid artifact path: ${artifactPath}`);
  }

  return `${workspaceNamespacePrefix(namespace)}/${normalizedPath}`;
}

function parseSandboxResponse<T>(payloadText: string): Omit<T, "provider"> {
  if (!payloadText) {
    throw new Error("Sandbox Lambda returned an empty response");
  }

  try {
    const parsed = JSON.parse(payloadText);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Sandbox Lambda response must be an object");
    }
    return parsed as Omit<T, "provider">;
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

function networkAccessFor(config: WorkspaceSandboxConfig): "disabled" | "public" {
  const options = isRecordObject(config.options) ? config.options : {};
  return options.networkAccess === "public" ? "public" : "disabled";
}

function missingFunctionName(runtime: "node" | "python" | "bash"): never {
  throw new Error(
    `Workspace sandbox ${runtime} Lambda is not configured. Set config.workspace.sandbox.options.${runtime}FunctionName or SANDBOX_${runtime.toUpperCase()}_FUNCTION_NAME.`,
  );
}
