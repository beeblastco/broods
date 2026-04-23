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

export async function fetchWithTiming(
  url: string,
  body: unknown,
): Promise<TimingResult> {
  const startTime = Date.now();
  let firstByteTime: number | null = null;
  let responseSizeBytes = 0;
  let sseText = "";

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const reader = response.body!.getReader();
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
