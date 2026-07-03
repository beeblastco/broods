/**
 * Resolves the harness's own public Function URL at runtime.
 *
 * Background-job callbacks need a URL to POST to, but a Lambda cannot reference
 * its own Function URL via env without a deploy-time cycle. Instead we ask the
 * Lambda API for it once and cache it. Returns undefined off-Lambda or on error,
 * so callers degrade to poll-only delivery.
 */

import { GetFunctionUrlConfigCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { optionalEnv } from "../_shared/env.ts";
import { logWarn } from "../_shared/log.ts";

let cached: Promise<string | undefined> | undefined;

export function getHarnessPublicUrl(): Promise<string | undefined> {
  if (!cached) {
    cached = resolve();
  }
  return cached;
}

async function resolve(): Promise<string | undefined> {
  // The self-hosted container has a stable public hostname, so it is set
  // directly instead of discovered from the Lambda API.
  const configured = optionalEnv("PUBLIC_BASE_URL");
  if (configured) {
    return configured.replace(/\/+$/, "");
  }

  const functionName = optionalEnv("AWS_LAMBDA_FUNCTION_NAME");
  if (!functionName) {
    return undefined;
  }
  try {
    const client = new LambdaClient({ region: process.env.AWS_REGION });
    const result = await client.send(new GetFunctionUrlConfigCommand({ FunctionName: functionName }));
    return result.FunctionUrl?.replace(/\/+$/, "");
  } catch (err) {
    logWarn("Could not resolve harness Function URL for background callbacks", {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
