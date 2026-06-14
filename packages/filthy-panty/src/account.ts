/**
 * Standalone fetch helpers for the account-manage HTTP API. They read the
 * service URLs from the environment (ACCOUNT_SERVICE_URL / AGENT_SERVICE_URL)
 * at call time, matching the deployed Function URL endpoints.
 */

import type {
  Account,
  Agent,
  AsyncStatus,
  CustomTool,
  Sandbox,
  Skill,
  Workspace,
} from "./types.ts";
import { DEFAULT_CORE_BASE_URL, normalizeHttpServiceUrl } from "./client.ts";

// Create a new account.
export async function createAccount(username: string): Promise<Account> {
  const response = await fetch(`${process.env.ACCOUNT_SERVICE_URL!}/accounts`, {
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
  const response = await fetch(`${process.env.ACCOUNT_SERVICE_URL!}/accounts/me/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${secret}` },
    body: JSON.stringify({ name, description, config }),
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
  const response = await fetch(`${process.env.ACCOUNT_SERVICE_URL!}/accounts/me/sandboxes`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${secret}` },
    body: JSON.stringify({ name, description, config }),
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
  const response = await fetch(`${process.env.ACCOUNT_SERVICE_URL!}/accounts/me/workspaces`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${secret}` },
    body: JSON.stringify({ name, description, config }),
  });

  if (!response.ok) throw new Error(`Create workspace failed: ${response.status} ${await response.text()}`);

  return await response.json() as Workspace;
}

export async function createSkill(secret: string, input: Record<string, unknown>): Promise<Skill> {
  const response = await fetch(`${process.env.ACCOUNT_SERVICE_URL!}/accounts/me/skills`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${secret}` },
    body: JSON.stringify(input),
  });

  if (!response.ok) throw new Error(`Create skill failed: ${response.status} ${await response.text()}`);

  return await response.json() as Skill;
}

export async function createTool(secret: string, input: Record<string, unknown>): Promise<CustomTool> {
  const response = await fetch(`${process.env.ACCOUNT_SERVICE_URL!}/accounts/me/tools`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${secret}` },
    body: JSON.stringify(input),
  });

  if (!response.ok) throw new Error(`Create tool failed: ${response.status} ${await response.text()}`);

  return await response.json() as CustomTool;
}

export async function listSkills(secret: string): Promise<Skill[]> {
  const response = await fetch(`${process.env.ACCOUNT_SERVICE_URL!}/accounts/me/skills`, {
    method: "GET",
    headers: { "Authorization": `Bearer ${secret}` },
  });

  if (!response.ok) throw new Error(`List skills failed: ${response.status} ${await response.text()}`);

  const payload = await response.json() as { skills: Skill[] };

  return payload.skills;
}

export async function getSkill(secret: string, skillName: string): Promise<Skill | null> {
  const response = await fetch(`${process.env.ACCOUNT_SERVICE_URL!}/accounts/me/skills/${encodeURIComponent(skillName)}`, {
    method: "GET",
    headers: { "Authorization": `Bearer ${secret}` },
  });

  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Get skill failed: ${response.status} ${await response.text()}`);

  return await response.json() as Skill;
}

export async function deleteAgent(secret: string, agentId: string): Promise<void> {
  const response = await fetch(`${process.env.ACCOUNT_SERVICE_URL!}/accounts/me/agents/${encodeURIComponent(agentId)}`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${secret}` },
  });

  if (!response.ok) throw new Error(`Delete agent failed: ${response.status} ${await response.text()}`);
}

export async function deleteSkill(secret: string, skillName: string): Promise<boolean> {
  const response = await fetch(`${process.env.ACCOUNT_SERVICE_URL!}/accounts/me/skills/${encodeURIComponent(skillName)}`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${secret}` },
  });

  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`Delete skill failed: ${response.status} ${await response.text()}`);

  const payload = await response.json() as { deleted: boolean };

  return payload.deleted;
}

// Update current account.
export async function updateAccount(secret: string, config: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${process.env.ACCOUNT_SERVICE_URL!}/accounts/me`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${secret}` },
    body: JSON.stringify({ config }),
  });

  if (!response.ok) throw new Error(`Update failed: ${response.status} ${await response.text()}`);
}

// Delete current account.
export async function deleteAccount(secret: string): Promise<void> {
  const response = await fetch(`${process.env.ACCOUNT_SERVICE_URL!}/accounts/me`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${secret}` },
  });

  if (!response.ok) throw new Error(`Delete failed: ${response.status} ${await response.text()}`);
}

// Post an async request to the agent service.
export async function postAsyncRequest(body: unknown, secret: string): Promise<{ statusUrl: string }> {
  const baseUrl = normalizeHttpServiceUrl(
    process.env.FILTHY_PANTY_BASE_URL ||
    process.env.FILTHY_PANTY_HOST ||
    process.env.FILTHY_PANTY_AGENT_SERVICE_URL ||
    process.env.FILTHY_PANTY_HARNESS_URL ||
    process.env.AGENT_SERVICE_URL ||
    DEFAULT_CORE_BASE_URL,
  );
  const response = await fetch(`${baseUrl}/async`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${secret}` },
    body: JSON.stringify(body),
  });

  if (response.status !== 202) throw new Error(`Expected 202, got ${response.status}: ${await response.text()}`);

  return await response.json() as { statusUrl: string };
}

// Poll async status until it reaches a terminal or user-actionable state.
export async function pollStatus(secret: string, statusUrl: string): Promise<AsyncStatus> {
  const deadline = Date.now() + 180000;

  while (Date.now() < deadline) {
    const response = await fetch(statusUrl, { method: "GET", headers: { "Authorization": `Bearer ${secret}` } });

    if (response.status === 404) return { status: "not_found" };
    if (response.status !== 200) throw new Error(`Status check failed: ${response.status}`);

    const payload = await response.json() as AsyncStatus;
    if (payload.status === "awaiting_approval" || payload.status === "completed" || payload.status === "failed") {
      return payload;
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error("Polling timeout");
}
