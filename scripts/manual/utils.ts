import {
  outputOrEnv,
  optionalScriptEnv,
  parseJson,
  stripTrailingSlash,
} from "../utils.ts";

const HARNESS_MEMORY_MB = 256;
const LAMBDA_ARM64_GB_SECOND = 0.0000133334;
const LAMBDA_REQUEST_COST = 0.0000002;
const LAMBDA_STREAMING_PER_GB = 0.008;
const STREAMING_FREE_BYTES = 6 * 1024 * 1024;

interface LambdaCost {
  computeCost: number;
  requestCost: number;
  streamingCost: number;
  totalCost: number;
}

function calculateLambdaCost(
  billedDurationMs: number,
  responseSizeBytes: number,
): LambdaCost {
  const memoryGb = HARNESS_MEMORY_MB / 1024;
  const durationSeconds = billedDurationMs / 1000;
  const computeCost = memoryGb * durationSeconds * LAMBDA_ARM64_GB_SECOND;
  const requestCost = LAMBDA_REQUEST_COST;
  const billableStreamingBytes = Math.max(
    0,
    responseSizeBytes - STREAMING_FREE_BYTES,
  );
  const streamingCost =
    (billableStreamingBytes / (1024 * 1024 * 1024)) * LAMBDA_STREAMING_PER_GB;

  return {
    computeCost,
    requestCost,
    streamingCost,
    totalCost: computeCost + requestCost + streamingCost,
  };
}

interface TimingResult {
  ttfbMs: number;
  totalMs: number;
  responseSizeBytes: number;
  sseText: string;
  response: Response;
}

interface CreatedManualAccount {
  accountSecret: string;
  account?: {
    accountId?: string;
    username?: string;
  };
}

export interface ManualTestAccount {
  accountId?: string;
  username?: string;
  accountSecret: string;
}

export function optionalManualEnv(name: string): string | undefined {
  return optionalScriptEnv(name);
}

export function manualFunctionUrl(): string {
  return outputOrEnv("FUNCTION_URL", "harnessProcessingUrl");
}

export function manualAccountManageUrl(): string {
  return stripTrailingSlash(outputOrEnv("ACCOUNT_MANAGE_URL", "accountManageUrl"));
}

export async function withManualTestAccount<T>(
  run: (account: ManualTestAccount) => Promise<T>,
): Promise<T> {
  const account = await createManualAccount();
  const manualAccount = {
    accountId: account.account?.accountId,
    username: account.account?.username,
    accountSecret: account.accountSecret,
  } satisfies ManualTestAccount;

  console.log("Created manual test account:");
  console.log(JSON.stringify({
    accountId: manualAccount.accountId,
    username: manualAccount.username,
  }, null, 2));

  let runFailed = false;
  try {
    return await run(manualAccount);
  } catch (err) {
    runFailed = true;
    throw err;
  } finally {
    try {
      await deleteManualAccount(manualAccount);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (runFailed) {
        console.error(`Failed to delete manual test account after probe failure: ${message}`);
      } else {
        throw err;
      }
    }
  }
}

export async function fetchWithTiming(
  url: string,
  body: unknown,
  accountSecret: string,
): Promise<TimingResult> {
  const startTime = Date.now();
  let firstByteTime: number | null = null;
  let responseSizeBytes = 0;
  let sseText = "";

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
      "Authorization": `Bearer ${accountSecret}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Direct API request failed with HTTP ${response.status}: ${await response.text()}`);
  }

  if (!response.body) {
    throw new Error("Direct API response did not include a stream body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (firstByteTime === null) {
      firstByteTime = Date.now();
    }
    responseSizeBytes += value.byteLength;
    const chunk = decoder.decode(value, { stream: true });
    sseText += chunk;
    process.stdout.write(chunk);
  }

  const ttfbMs = firstByteTime ? firstByteTime - startTime : 0;
  const totalMs = Date.now() - startTime;

  return { ttfbMs, totalMs, responseSizeBytes, sseText, response };
}

async function createManualAccount(): Promise<CreatedManualAccount> {
  const accountManageUrl = manualAccountManageUrl();
  const username = optionalManualEnv("MANUAL_ACCOUNT_USERNAME") ?? `manual-direct-api-${Date.now()}`;
  const response = await fetch(`${accountManageUrl}/accounts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      username,
      description: "Temporary account created by scripts/manual direct API probes.",
      config: {},
    }),
  });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Manual account creation failed with HTTP ${response.status}: ${text}`);
  }

  const payload = parseJson(text);
  if (!isCreatedManualAccount(payload)) {
    throw new Error(`Manual account creation response did not include accountSecret: ${text}`);
  }

  return payload;
}

async function deleteManualAccount(account: ManualTestAccount): Promise<void> {
  const accountManageUrl = manualAccountManageUrl();
  const response = await fetch(`${accountManageUrl}/accounts/me`, {
    method: "DELETE",
    headers: {
      "Authorization": `Bearer ${account.accountSecret}`,
    },
  });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Manual account deletion failed with HTTP ${response.status}: ${text}`);
  }

  console.log("Deleted manual test account:");
  console.log(text ? JSON.stringify(parseJson(text), null, 2) : "{}");
}

function isCreatedManualAccount(value: unknown): value is CreatedManualAccount {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as { accountSecret?: unknown }).accountSecret === "string",
  );
}

export function printTimingResults(result: TimingResult): void {
  const cost = calculateLambdaCost(result.totalMs, result.responseSizeBytes);

  console.log("\n--- Timing Results ---");
  console.log(`TTFB:          ${result.ttfbMs}ms`);
  console.log(`Total Time:    ${result.totalMs}ms`);
  console.log(`Response Size: ${(result.responseSizeBytes / 1024).toFixed(1)} KB`);
  console.log("");
  console.log(`--- Cost Estimate (ARM64, ${HARNESS_MEMORY_MB} MB, eu-central-1) ---`);
  console.log(`  (based on client-side wall time — actual billed duration is lower)`);
  console.log(`Compute:   $${cost.computeCost.toFixed(8)}`);
  console.log(`Request:   $${cost.requestCost.toFixed(8)}`);
  console.log(`Streaming: $${cost.streamingCost.toFixed(8)}`);
  console.log(`Total:     $${cost.totalCost.toFixed(8)}`);
  console.log("---------------------------------------------------");
}
