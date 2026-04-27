import { requireManualEnv } from "./utils.ts";

const FUNCTION_URL = requireManualEnv("FUNCTION_URL");
const DIRECT_API_SECRET = requireManualEnv("DIRECT_API_SECRET");
const POLL_INTERVAL_MS = Number(process.env.ASYNC_POLL_INTERVAL_MS ?? "2000");
const POLL_TIMEOUT_MS = Number(process.env.ASYNC_POLL_TIMEOUT_MS ?? "180000");

interface AsyncAcceptedResponse {
  statusUrl: string;
}

interface AsyncStatusResponse {
  eventId: string;
  conversationKey?: string;
  status: "processing" | "completed" | "failed" | "not_found";
  response?: string;
  error?: string;
}

const eventId = `async-tool-${Date.now()}`;
const conversationKey = `async-tool-${Date.now()}`;
const asyncUrl = new URL("/async", ensureTrailingSlash(FUNCTION_URL)).toString();
const startTime = Date.now();

console.log("POST", asyncUrl);
console.log("eventId:", eventId);
console.log("conversationKey:", conversationKey);

const accepted = await postAsyncRequest(asyncUrl, {
  eventId,
  conversationKey,
  events: [
    {
      role: "system",
      content: "Be concise after using tools.",
      persist: false,
    },
    {
      role: "user",
      content: [{ type: "text", text: "Search the web for the latest weather in Hanoi." }],
    },
  ],
});

console.log("\nAccepted:");
console.log(JSON.stringify(accepted, null, 2));
console.log("\nPolling", accepted.statusUrl);

const result = await pollStatus(accepted.statusUrl);
const totalMs = Date.now() - startTime;

console.log("\nFinal status:");
console.log(JSON.stringify(result, null, 2));
console.log(`\nTotal elapsed: ${totalMs}ms`);

if (result.status !== "completed") {
  process.exitCode = 1;
}

async function postAsyncRequest(url: string, body: unknown): Promise<AsyncAcceptedResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: authorizedJsonHeaders(),
    body: JSON.stringify(body),
  });

  const payload = await readJson(response);
  if (response.status !== 202) {
    throw new Error(`Expected 202 from async API, got ${response.status}: ${JSON.stringify(payload)}`);
  }

  if (!payload || typeof payload !== "object" || typeof (payload as { statusUrl?: unknown }).statusUrl !== "string") {
    throw new Error(`Async API response did not include statusUrl: ${JSON.stringify(payload)}`);
  }

  return payload as AsyncAcceptedResponse;
}

async function pollStatus(statusUrl: string): Promise<AsyncStatusResponse> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const response = await fetch(statusUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${DIRECT_API_SECRET}`,
      },
    });
    const payload = await readJson(response);

    if (response.status !== 200) {
      throw new Error(`Expected 200 from status API, got ${response.status}: ${JSON.stringify(payload)}`);
    }

    const status = parseStatusPayload(payload);
    console.log(`[${new Date().toISOString()}] ${status.status}`);

    if (status.status === "completed" || status.status === "failed" || status.status === "not_found") {
      return status;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out after ${POLL_TIMEOUT_MS}ms waiting for async result`);
}

function parseStatusPayload(payload: unknown): AsyncStatusResponse {
  if (!payload || typeof payload !== "object") {
    throw new Error(`Invalid status payload: ${JSON.stringify(payload)}`);
  }

  const candidate = payload as Partial<AsyncStatusResponse>;
  if (
    typeof candidate.eventId !== "string" ||
    !["processing", "completed", "failed", "not_found"].includes(String(candidate.status))
  ) {
    throw new Error(`Invalid status payload: ${JSON.stringify(payload)}`);
  }

  return candidate as AsyncStatusResponse;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON response: ${err instanceof Error ? err.message : String(err)}\n${text}`);
  }
}

function authorizedJsonHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${DIRECT_API_SECRET}`,
  };
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
