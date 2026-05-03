/**
 * Shared helpers for local and CI scripts.
 */

import type { AccountConfig, AccountModelProviderName } from "../functions/_shared/accounts.ts";

// You can set here or change inisde the GH Actions variables
const DEFAULT_ACCOUNT_MODEL_PROVIDER = "google";
const DEFAULT_ACCOUNT_MODEL_ID = "gemma-4-31b-it";

export interface PublicAccount {
  accountId: string;
  username: string;
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON response: ${err instanceof Error ? err.message : String(err)}\n${text}`);
  }
}

export function createScriptAccountRuntimeConfig(): AccountConfig {
  const provider = parseAccountModelProvider(process.env.ACCOUNT_MODEL_PROVIDER ?? DEFAULT_ACCOUNT_MODEL_PROVIDER);
  const modelId = process.env.ACCOUNT_MODEL_ID ?? DEFAULT_ACCOUNT_MODEL_ID;

  const modelOptionsRaw = process.env.ACCOUNT_MODEL_OPTIONS_JSON;
  const modelOptions = modelOptionsRaw ? parseJsonRecord(modelOptionsRaw, "ACCOUNT_MODEL_OPTIONS_JSON") : undefined;

  return {
    model: {
      provider,
      modelId,
      ...(modelOptions ? { options: modelOptions } : {}),
    },
    provider: {
      [provider]: accountProviderConfig(provider),
    },
    tools: accountToolsConfig(provider),
  };
}

export async function upsertScriptAccount(input: {
  accountServiceUrl: string;
  adminSecret: string;
  username: string | undefined;
  description: string | undefined;
  config: AccountConfig;
}): Promise<PublicAccount> {
  const existing = await findExistingAccount(input.accountServiceUrl, input.adminSecret, input.username);
  const body = {
    username: input.username,
    description: input.description,
    config: input.config,
  };

  if (existing) {
    const updated = await accountApi(
      input.accountServiceUrl,
      input.adminSecret,
      "PATCH",
      `/accounts/${encodeURIComponent(existing.accountId)}`,
      body,
    );
    return parseAccountResponse(updated);
  }

  const created = await publicAccountApi(input.accountServiceUrl, "POST", "/accounts", body);
  return parseAccountResponse(created);
}

async function findExistingAccount(
  baseUrl: string,
  adminSecret: string,
  username: string | undefined,
): Promise<PublicAccount | null> {
  if (!username) {
    return null;
  }

  const response = await accountApi(baseUrl, adminSecret, "GET", "/accounts");
  if (!isRecord(response) || !Array.isArray(response.accounts)) {
    throw new Error(`Account list response must include accounts array. Got: ${JSON.stringify(response)}`);
  }

  return response.accounts.find((entry): entry is PublicAccount =>
    isPublicAccount(entry) && entry.username === username,
  ) ?? null;
}

async function accountApi(
  baseUrl: string,
  adminSecret: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  return requestJson(`${baseUrl}${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${adminSecret}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function publicAccountApi(
  baseUrl: string,
  method: string,
  path: string,
  body: unknown,
): Promise<unknown> {
  return requestJson(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function requestJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${url} failed: ${response.status} ${bodyText}`);
  }

  return bodyText ? parseJson(bodyText) : {};
}

function parseAccountResponse(value: unknown): PublicAccount {
  if (!isRecord(value) || !isPublicAccount(value.account)) {
    throw new Error("Account response must include account.accountId and account.username");
  }

  return value.account;
}

function isPublicAccount(value: unknown): value is PublicAccount {
  return isRecord(value) &&
    typeof value.accountId === "string" &&
    typeof value.username === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseAccountModelProvider(value: string): AccountModelProviderName {
  if (value === "google" || value === "openai" || value === "bedrock" || value === "gateway") {
    return value;
  }

  throw new Error("ACCOUNT_MODEL_PROVIDER must be one of: google, openai, bedrock, gateway");
}

function accountProviderConfig(provider: AccountModelProviderName): Record<string, unknown> {
  const explicitConfigRaw = process.env.ACCOUNT_PROVIDER_CONFIG_JSON;
  if (explicitConfigRaw) {
    return parseJsonRecord(explicitConfigRaw, "ACCOUNT_PROVIDER_CONFIG_JSON");
  }

  switch (provider) {
    case "google":
      return { apiKey: requiredEnv("ACCOUNT_GOOGLE_API_KEY") };
    case "openai":
      return {
        apiKey: requiredEnv("ACCOUNT_OPENAI_API_KEY"),
        ...optionalStringEnv("ACCOUNT_OPENAI_BASE_URL", "OPENAI_BASE_URL"),
        ...optionalStringEnv("ACCOUNT_OPENAI_ORGANIZATION", "OPENAI_ORGANIZATION"),
        ...optionalStringEnv("ACCOUNT_OPENAI_PROJECT", "OPENAI_PROJECT"),
      };
    case "bedrock":
      return {
        apiKey: requiredEnv("ACCOUNT_BEDROCK_API_KEY"),
        ...optionalStringEnv("ACCOUNT_BEDROCK_REGION", "AWS_REGION"),
        ...optionalStringEnv("ACCOUNT_BEDROCK_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"),
        ...optionalStringEnv("ACCOUNT_BEDROCK_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY"),
        ...optionalStringEnv("ACCOUNT_BEDROCK_SESSION_TOKEN", "AWS_SESSION_TOKEN"),
      };
    case "gateway":
      return { apiKey: requiredEnv("ACCOUNT_GATEWAY_API_KEY") };
  }
}

function accountToolsConfig(provider: AccountModelProviderName): Record<string, Record<string, unknown>> {
  const explicitToolsRaw = process.env.ACCOUNT_TOOLS_JSON;
  if (explicitToolsRaw) {
    const parsed = parseJsonRecord(explicitToolsRaw, "ACCOUNT_TOOLS_JSON");
    return parsed as Record<string, Record<string, unknown>>;
  }

  const tools: Record<string, Record<string, unknown>> = {
    filesystem: { enabled: envFlag("ACCOUNT_ENABLE_FILESYSTEM_TOOL", true) },
    tasks: { enabled: envFlag("ACCOUNT_ENABLE_TASKS_TOOL", true) },
  };

  if (envFlag("ACCOUNT_ENABLE_TAVILY_TOOLS", false)) {
    const tavilyApiKey = process.env.ACCOUNT_TAVILY_API_KEY;
    if (tavilyApiKey) {
      tools.tavilySearch = {
        enabled: true,
        apiKey: tavilyApiKey,
        ...optionalNumberEnv("ACCOUNT_TAVILY_SEARCH_MAX_RESULTS", "maxResults"),
        ...optionalStringEnv("ACCOUNT_TAVILY_SEARCH_DEPTH", "searchDepth"),
        ...optionalBooleanEnv("ACCOUNT_TAVILY_SEARCH_INCLUDE_ANSWER", "includeAnswer"),
        ...optionalStringEnv("ACCOUNT_TAVILY_SEARCH_TOPIC", "topic"),
      };
      tools.tavilyExtract = {
        enabled: true,
        apiKey: tavilyApiKey,
        ...optionalStringEnv("ACCOUNT_TAVILY_EXTRACT_DEPTH", "extractDepth"),
        ...optionalStringEnv("ACCOUNT_TAVILY_EXTRACT_FORMAT", "format"),
      };
    }
  }

  if (provider === "google" && envFlag("ACCOUNT_ENABLE_GOOGLE_SEARCH", false)) {
    const configRaw = process.env.ACCOUNT_GOOGLE_SEARCH_CONFIG_JSON;
    tools.googleSearch = {
      enabled: true,
      ...(configRaw ? parseJsonRecord(configRaw, "ACCOUNT_GOOGLE_SEARCH_CONFIG_JSON") : {}),
    };
  }

  return Object.fromEntries(
    Object.entries(tools).filter(([, config]) => config.enabled !== false),
  );
}

function parseJsonRecord(raw: string, name: string): Record<string, unknown> {
  const parsed = parseJson(raw);
  if (!isRecord(parsed)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return parsed;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function envFlag(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) {
    return defaultValue;
  }

  if (value === "true") return true;
  if (value === "false") return false;

  console.warn(`Invalid value for ${name}: "${value}", using default: ${defaultValue}`);
  return defaultValue;
}

function optionalStringEnv(...names: string[]): Record<string, string> {
  for (const name of names) {
    const value = process.env[name];
    if (value) {
      return { [name]: value };
    }
  }
  return {};
}

function optionalNumberEnv(envName: string, key: string): Record<string, number> {
  const value = process.env[envName];
  if (!value) return {};

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    console.warn(`Invalid number for ${envName}: "${value}", ignoring`);
    return {};
  }
  return { [key]: parsed };
}

function optionalBooleanEnv(envName: string, key: string): Record<string, boolean> {
  const value = process.env[envName];
  if (!value) return {};

  if (value === "true") return { [key]: true };
  if (value === "false") return { [key]: false };

  console.warn(`Invalid boolean for ${envName}: "${value}", ignoring`);
  return {};
}