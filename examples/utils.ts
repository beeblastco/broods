/**
 * Shared utilities for example scripts.
 */

// Service URLs from environment
export const ACCOUNT_SERVICE_URL = process.env.ACCOUNT_SERVICE_URL!;
export const AGENT_SERVICE_URL = process.env.AGENT_SERVICE_URL!;

// Types
export interface Account {
  account: {
    accountId: string;
    username: string;
  }
  accountSecret: string;
}

export interface AsyncStatus {
  status: "processing" | "completed" | "failed" | "not_found";
  response?: string;
  error?: string;
}

// Create a new account
export async function createAccount(username: string, config: Record<string, unknown>): Promise<Account> {
  const response = await fetch(`${ACCOUNT_SERVICE_URL}/accounts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, config }),
  });

  if (!response.ok) throw new Error(`Create failed: ${response.status} ${await response.text()}`);

  const payload = await response.json() as Account;
  if (!payload.account?.accountId || !payload.accountSecret) {
    throw new Error("Response missing accountId or accountSecret");
  }

  return payload;
}

// Update current account
export async function updateAccount(accountSecret: string, config: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${ACCOUNT_SERVICE_URL}/accounts/me`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${accountSecret}` },
    body: JSON.stringify({ config }),
  });

  if (!response.ok) throw new Error(`Update failed: ${response.status} ${await response.text()}`);
}

// Delete current account
export async function deleteAccount(accountSecret: string): Promise<void> {
  const response = await fetch(`${ACCOUNT_SERVICE_URL}/accounts/me`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${accountSecret}` },
  });

  if (!response.ok) throw new Error(`Delete failed: ${response.status} ${await response.text()}`);
}

// Stream SSE response from agent service
export async function* streamSSE(body: unknown, accountSecret: string): AsyncGenerator<string> {
  const response = await fetch(AGENT_SERVICE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "text/event-stream", "Authorization": `Bearer ${accountSecret}` },
    body: JSON.stringify(body),
  });

  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  if (!response.body) throw new Error("No response body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data: ")) yield line.slice(6);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// Post async request to agent service
export async function postAsyncRequest(body: unknown, accountSecret: string): Promise<{ statusUrl: string }> {
  const response = await fetch(`${AGENT_SERVICE_URL}/async`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${accountSecret}` },
    body: JSON.stringify(body),
  });

  if (response.status !== 202) throw new Error(`Expected 202, got ${response.status}: ${await response.text()}`);
  return await response.json() as { statusUrl: string };
}

// Poll async status until completed or failed
export async function pollStatus(accountSecret: string, statusUrl: string): Promise<AsyncStatus> {
  const deadline = Date.now() + 180000;

  while (Date.now() < deadline) {
    const response = await fetch(statusUrl, { method: "GET", headers: { "Authorization": `Bearer ${accountSecret}` } });

    if (response.status === 404) return { status: "not_found" };
    if (response.status !== 200) throw new Error(`Status check failed: ${response.status}`);

    const payload = await response.json() as AsyncStatus;
    console.log(`Status: ${payload.status}`);

    if (payload.status === "completed" || payload.status === "failed") return payload;
    await new Promise((r) => setTimeout(r, 2000));
  }

  throw new Error("Polling timeout");
}