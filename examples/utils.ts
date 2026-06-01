/**
 * Shared utilities for example scripts.
 */

import type { ToolApprovalSummary } from "../functions/harness-processing/harness.ts";

// Service URLs from environment
export const ACCOUNT_SERVICE_URL = process.env.ACCOUNT_SERVICE_URL!;
export const AGENT_SERVICE_URL = process.env.AGENT_SERVICE_URL!;

// Types
export interface Account {
  account: {
    accountId: string;
    username: string;
  }
  secret: string;
}

export interface Agent {
  accountId: string;
  agentId: string;
  name: string;
}

export interface Sandbox {
  sandboxId: string;
  name: string;
}

export interface Workspace {
  workspaceId: string;
  name: string;
}

export interface AsyncStatus {
  status: "processing" | "awaiting_approval" | "completed" | "failed" | "not_found";
  response?: string;
  error?: string;
  approvals?: ToolApprovalSummary[];
}

export interface Skill {
  path: string;
  name: string;
  description: string;
  files?: Array<{
    path: string;
    size?: number;
  }>;
}

// Create a new account
export async function createAccount(username: string): Promise<Account> {
  const response = await fetch(`${ACCOUNT_SERVICE_URL}/accounts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
  });

  if (!response.ok) throw new Error(`Create failed: ${response.status} ${await response.text()}`);

  const payload = await response.json() as Account;
  if (!payload.account?.accountId || !payload.secret) {
    throw new Error("Response missing accountId or secret");
  }

  return payload;
}

export async function createAgent(
  secret: string,
  name: string,
  config: Record<string, unknown>,
  description?: string,
): Promise<Agent> {
  const response = await fetch(`${ACCOUNT_SERVICE_URL}/accounts/me/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${secret}` },
    body: JSON.stringify({ name, ...(description ? { description } : {}), config }),
  });

  if (!response.ok) throw new Error(`Create agent failed: ${response.status} ${await response.text()}`);
  return await response.json() as Agent;
}

// Create an account-scoped sandbox config (referenced from agent config by id).
export async function createSandbox(
  secret: string,
  name: string,
  config: Record<string, unknown>,
  description?: string,
): Promise<Sandbox> {
  const response = await fetch(`${ACCOUNT_SERVICE_URL}/accounts/me/sandboxes`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${secret}` },
    body: JSON.stringify({ name, ...(description ? { description } : {}), config }),
  });

  if (!response.ok) throw new Error(`Create sandbox failed: ${response.status} ${await response.text()}`);
  return await response.json() as Sandbox;
}

// Create an account-scoped workspace config (referenced from agent config by id).
export async function createWorkspace(
  secret: string,
  name: string,
  config: Record<string, unknown>,
  description?: string,
): Promise<Workspace> {
  const response = await fetch(`${ACCOUNT_SERVICE_URL}/accounts/me/workspaces`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${secret}` },
    body: JSON.stringify({ name, ...(description ? { description } : {}), config }),
  });

  if (!response.ok) throw new Error(`Create workspace failed: ${response.status} ${await response.text()}`);
  return await response.json() as Workspace;
}

export async function createSkill(
  secret: string, 
  input: Record<string, unknown>
): Promise<Skill> {
  const response = await fetch(`${ACCOUNT_SERVICE_URL}/accounts/me/skills`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${secret}` },
    body: JSON.stringify(input),
  });

  if (!response.ok) throw new Error(`Create skill failed: ${response.status} ${await response.text()}`);
  return await response.json() as Skill;
}

export async function listSkills(secret: string): Promise<Skill[]> {
  const response = await fetch(`${ACCOUNT_SERVICE_URL}/accounts/me/skills`, {
    method: "GET",
    headers: { "Authorization": `Bearer ${secret}` },
  });

  if (!response.ok) throw new Error(`List skills failed: ${response.status} ${await response.text()}`);
  const payload = await response.json() as { skills: Skill[] };
  return payload.skills;
}

export async function getSkill(secret: string, skillName: string): Promise<Skill | null> {
  const response = await fetch(`${ACCOUNT_SERVICE_URL}/accounts/me/skills/${encodeURIComponent(skillName)}`, {
    method: "GET",
    headers: { "Authorization": `Bearer ${secret}` },
  });

  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Get skill failed: ${response.status} ${await response.text()}`);
  return await response.json() as Skill;
}

export async function deleteAgent(secret: string, agentId: string): Promise<void> {
  const response = await fetch(`${ACCOUNT_SERVICE_URL}/accounts/me/agents/${encodeURIComponent(agentId)}`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${secret}` },
  });

  if (!response.ok) throw new Error(`Delete agent failed: ${response.status} ${await response.text()}`);
}

export async function deleteSkill(secret: string, skillName: string): Promise<boolean> {
  const response = await fetch(`${ACCOUNT_SERVICE_URL}/accounts/me/skills/${encodeURIComponent(skillName)}`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${secret}` },
  });

  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`Delete skill failed: ${response.status} ${await response.text()}`);
  const payload = await response.json() as { deleted: boolean };
  return payload.deleted;
}

// Update current account
export async function updateAccount(secret: string, config: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${ACCOUNT_SERVICE_URL}/accounts/me`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${secret}` },
    body: JSON.stringify({ config }),
  });

  if (!response.ok) throw new Error(`Update failed: ${response.status} ${await response.text()}`);
}

// Delete current account
export async function deleteAccount(secret: string): Promise<void> {
  const response = await fetch(`${ACCOUNT_SERVICE_URL}/accounts/me`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${secret}` },
  });

  if (!response.ok) throw new Error(`Delete failed: ${response.status} ${await response.text()}`);
}

// Stream SSE response from agent service
export async function* streamSSE(body: unknown, secret: string): AsyncGenerator<string> {
  const response = await fetch(AGENT_SERVICE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "text/event-stream", "Authorization": `Bearer ${secret}` },
    body: JSON.stringify(body),
  });

  if (!response.ok) throw new Error(`Request failed: ${response.status} ${await response.text()}`);
  if (!response.body) throw new Error("No response body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let chunks = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        chunks += 1;
        yield line.slice(6);
      }
    }
    if (chunks === 0) {
      throw new Error("SSE stream ended without any data events");
    }
  } finally {
    reader.releaseLock();
  }
}

// Post async request to agent service
export async function postAsyncRequest(body: unknown, secret: string): Promise<{ statusUrl: string }> {
  const response = await fetch(`${AGENT_SERVICE_URL}/async`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${secret}` },
    body: JSON.stringify(body),
  });

  if (response.status !== 202) throw new Error(`Expected 202, got ${response.status}: ${await response.text()}`);
  return await response.json() as { statusUrl: string };
}

// Poll async status until it reaches a terminal or user-actionable state
export async function pollStatus(secret: string, statusUrl: string): Promise<AsyncStatus> {
  const deadline = Date.now() + 180000;

  while (Date.now() < deadline) {
    const response = await fetch(statusUrl, { method: "GET", headers: { "Authorization": `Bearer ${secret}` } });

    if (response.status === 404) return { status: "not_found" };
    if (response.status !== 200) throw new Error(`Status check failed: ${response.status}`);

    const payload = await response.json() as AsyncStatus;
    console.log(`Status: ${payload.status}`);

    if (payload.status === "awaiting_approval" || payload.status === "completed" || payload.status === "failed") {
      return payload;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  throw new Error("Polling timeout");
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}