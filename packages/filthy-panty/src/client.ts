/**
 * Typed fetch client for the account-manage and harness HTTP APIs.
 * Standalone functions read the service URLs from the environment
 * (ACCOUNT_SERVICE_URL / AGENT_SERVICE_URL) at call time via requireEnv,
 * matching the deployed Function URL endpoints. Reading lazily keeps the
 * module importable in environments where those vars are unset.
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
import { FilthyPantySyncClient } from "./sync.ts";

// Create a new account
export async function createAccount(username: string): Promise<Account> {
  const response = await fetch(`${requireEnv("ACCOUNT_SERVICE_URL")}/accounts`, {
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
  const response = await fetch(`${requireEnv("ACCOUNT_SERVICE_URL")}/accounts/me/agents`, {
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
  const response = await fetch(`${requireEnv("ACCOUNT_SERVICE_URL")}/accounts/me/sandboxes`, {
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
  const response = await fetch(`${requireEnv("ACCOUNT_SERVICE_URL")}/accounts/me/workspaces`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${secret}` },
    body: JSON.stringify({ name, ...(description ? { description } : {}), config }),
  });

  if (!response.ok) throw new Error(`Create workspace failed: ${response.status} ${await response.text()}`);
  return await response.json() as Workspace;
}

export async function createSkill(
  secret: string,
  input: Record<string, unknown>,
): Promise<Skill> {
  const response = await fetch(`${requireEnv("ACCOUNT_SERVICE_URL")}/accounts/me/skills`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${secret}` },
    body: JSON.stringify(input),
  });

  if (!response.ok) throw new Error(`Create skill failed: ${response.status} ${await response.text()}`);
  return await response.json() as Skill;
}

export async function createTool(
  secret: string,
  input: Record<string, unknown>,
): Promise<CustomTool> {
  const response = await fetch(`${requireEnv("ACCOUNT_SERVICE_URL")}/accounts/me/tools`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${secret}` },
    body: JSON.stringify(input),
  });

  if (!response.ok) throw new Error(`Create tool failed: ${response.status} ${await response.text()}`);
  return await response.json() as CustomTool;
}

export async function listSkills(secret: string): Promise<Skill[]> {
  const response = await fetch(`${requireEnv("ACCOUNT_SERVICE_URL")}/accounts/me/skills`, {
    method: "GET",
    headers: { "Authorization": `Bearer ${secret}` },
  });

  if (!response.ok) throw new Error(`List skills failed: ${response.status} ${await response.text()}`);
  const payload = await response.json() as { skills: Skill[] };
  return payload.skills;
}

export async function getSkill(secret: string, skillName: string): Promise<Skill | null> {
  const response = await fetch(`${requireEnv("ACCOUNT_SERVICE_URL")}/accounts/me/skills/${encodeURIComponent(skillName)}`, {
    method: "GET",
    headers: { "Authorization": `Bearer ${secret}` },
  });

  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Get skill failed: ${response.status} ${await response.text()}`);
  return await response.json() as Skill;
}

export async function deleteAgent(secret: string, agentId: string): Promise<void> {
  const response = await fetch(`${requireEnv("ACCOUNT_SERVICE_URL")}/accounts/me/agents/${encodeURIComponent(agentId)}`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${secret}` },
  });

  if (!response.ok) throw new Error(`Delete agent failed: ${response.status} ${await response.text()}`);
}

export async function deleteSkill(secret: string, skillName: string): Promise<boolean> {
  const response = await fetch(`${requireEnv("ACCOUNT_SERVICE_URL")}/accounts/me/skills/${encodeURIComponent(skillName)}`, {
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
  const response = await fetch(`${requireEnv("ACCOUNT_SERVICE_URL")}/accounts/me`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${secret}` },
    body: JSON.stringify({ config }),
  });

  if (!response.ok) throw new Error(`Update failed: ${response.status} ${await response.text()}`);
}

// Delete current account
export async function deleteAccount(secret: string): Promise<void> {
  const response = await fetch(`${requireEnv("ACCOUNT_SERVICE_URL")}/accounts/me`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${secret}` },
  });

  if (!response.ok) throw new Error(`Delete failed: ${response.status} ${await response.text()}`);
}

// Post async request to agent service
export async function postAsyncRequest(body: unknown, secret: string): Promise<{ statusUrl: string }> {
  const response = await fetch(`${requireEnv("AGENT_SERVICE_URL")}/async`, {
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

export interface AgentRunInput {
  input: string;
  conversationKey?: string;
  eventId?: string;
}

export interface AgentRunResult {
  text: string;
  events: unknown[];
}

export interface FilthyPantyClientOptions {
  dashboardUrl?: string;
  token?: string;
  project?: string;
  environment?: string;
  agentServiceUrl?: string;
  accountSecret?: string;
  fetch?: typeof fetch;
}

export interface FilthyPantyGeneratedClient {
  agents: Record<string, ReturnType<FilthyPantyClient["agent"]>>;
}

export class FilthyPantyClient {
  private readonly dashboardUrl?: string;
  private readonly token?: string;
  private readonly project?: string;
  private readonly environment?: string;
  private readonly agentServiceUrl?: string;
  private readonly accountSecret?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: FilthyPantyClientOptions = {}) {
    this.dashboardUrl = options.dashboardUrl ?? process.env.FILTHY_PANTY_DASHBOARD_URL;
    this.token = options.token ?? process.env.FILTHY_PANTY_TOKEN;
    this.project = options.project;
    this.environment = options.environment;
    this.agentServiceUrl = options.agentServiceUrl ?? process.env.AGENT_SERVICE_URL;
    this.accountSecret = options.accountSecret ?? process.env.ACCOUNT_SECRET;
    this.fetchImpl = options.fetch ?? fetch;
  }

  agent(name: string, agentId: string) {
    return {
      id: agentId,
      run: (input: AgentRunInput) => this.run({ ...input, agentName: name, agentId: agentId }),
      stream: (input: AgentRunInput) => this.stream({ ...input, agentName: name, agentId: agentId }),
    };
  }

  async run(input: AgentRunInput & { agentId: string; agentName?: string }): Promise<AgentRunResult> {
    const events: unknown[] = [];
    let text = "";

    for await (const chunk of this.stream(input)) {
      const parsed = parseEvent(chunk);
      events.push(parsed);
      if (isTextEvent(parsed)) {
        text += parsed.text;
      }
    }

    return { text: text, events: events };
  }

  async *stream(input: AgentRunInput & { agentId: string; agentName?: string }): AsyncGenerator<string> {
    const body = {
      agentId: input.agentId,
      eventId: input.eventId ?? `cli-${Date.now()}`,
      conversationKey: input.conversationKey ?? "cli",
      events: [
        {
          role: "user",
          content: [{ type: "text", text: input.input }],
        },
      ],
    };

    const response = await this.openStream(input.agentName, body);
    if (!response.ok) {
      throw new Error(`Run failed: ${response.status} ${await response.text()}`);
    }
    if (!response.body) throw new Error("Run response has no body");

    yield* readSseData(response.body);
  }

  private async openStream(agentName: string | undefined, body: unknown): Promise<Response> {
    if (this.dashboardUrl && this.token && this.project && this.environment && agentName) {
      const sync = new FilthyPantySyncClient({
        dashboardUrl: this.dashboardUrl,
        token: this.token,
        fetch: this.fetchImpl,
      });
      return await sync.run(this.project, this.environment, agentName, body);
    }

    if (this.agentServiceUrl && this.accountSecret) {
      return await this.fetchImpl(this.agentServiceUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "text/event-stream",
          "Authorization": `Bearer ${this.accountSecret}`,
        },
        body: JSON.stringify(body),
      });
    }

    throw new Error("FilthyPantyClient requires either dashboardUrl/token/project/environment or agentServiceUrl/accountSecret");
  }
}

async function* readSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
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
        if (line.startsWith("data: ")) {
          yield line.slice(6);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseEvent(chunk: string): unknown {
  try {
    return JSON.parse(chunk);
  } catch {
    return chunk;
  }
}

function isTextEvent(value: unknown): value is { type: string; text: string } {
  return Boolean(value && typeof value === "object" && (value as { type?: unknown }).type === "text" && typeof (value as { text?: unknown }).text === "string");
}
