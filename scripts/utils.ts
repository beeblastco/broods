/**
 * Shared helpers for local and CI scripts.
 * Keep script-only environment, SST output, and JSON parsing utilities here.
 */

import { readFileSync } from "node:fs";

import type { AccountConfig, AccountModelProviderName } from "../functions/_shared/accounts.ts";

const DEFAULT_ACCOUNT_MODEL_PROVIDER = "google";
const DEFAULT_ACCOUNT_MODEL_ID = "gemma-4-31b-it";

export interface PublicAccount {
  accountId: string;
  username: string;
}

export function optionalScriptEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

export function requireScriptEnv(name: string): string {
  const value = optionalScriptEnv(name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export function outputOrEnv(envName: string, outputName: string): string {
  const explicit = optionalScriptEnv(envName);
  if (explicit) {
    return explicit;
  }

  const outputs = readSstOutputs();
  const value = outputs[outputName];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing ${envName} and .sst output ${outputName}`);
  }

  return value;
}

export function accountServiceUrl(): string {
  return stripTrailingSlash(outputOrEnv("ACCOUNT_SERVICE_URL", "accountServiceUrl"));
}

export function agentServiceUrl(): string {
  return stripTrailingSlash(outputOrEnv("AGENT_SERVICE_URL", "agentServiceUrl"));
}

export function harnessProcessingUrl(): string {
  return stripTrailingSlash(outputOrEnv("HARNESS_PROCESSING_URL", "harnessProcessingUrl"));
}

export function readSstOutputs(): Record<string, unknown> {
  try {
    const raw = readFileSync(".sst/outputs.json", "utf-8");
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch (err) {
    throw new Error(`Unable to read .sst/outputs.json: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON response: ${err instanceof Error ? err.message : String(err)}\n${text}`);
  }
}

export function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function createScriptAccountRuntimeConfig(): AccountConfig {
  const provider = parseAccountModelProvider(optionalScriptEnv("ACCOUNT_MODEL_PROVIDER") ?? DEFAULT_ACCOUNT_MODEL_PROVIDER);
  const modelId = optionalScriptEnv("ACCOUNT_MODEL_ID") ?? DEFAULT_ACCOUNT_MODEL_ID;
  const modelOptions = optionalJsonRecord("ACCOUNT_MODEL_OPTIONS_JSON");

  return {
    model: {
      provider,
      modelId,
      ...(modelOptions ? { options: modelOptions } : {}),
    },
    provider: {
      [provider]: accountProviderConfig(provider),
    },
    workspace: {
      enabled: true,
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

function parseAccountModelProvider(value: string): AccountModelProviderName {
  if (value === "google" || value === "openai" || value === "bedrock" || value === "gateway") {
    return value;
  }

  throw new Error("ACCOUNT_MODEL_PROVIDER must be one of: google, openai, bedrock, gateway");
}

function accountProviderConfig(provider: AccountModelProviderName): Record<string, unknown> {
  const explicitConfig = optionalJsonRecord("ACCOUNT_PROVIDER_CONFIG_JSON");
  if (explicitConfig) {
    return explicitConfig;
  }

  switch (provider) {
    case "google":
      return {
        apiKey: firstRequiredEnv("ACCOUNT_GOOGLE_API_KEY"),
      };
    case "openai":
      return {
        apiKey: firstRequiredEnv("ACCOUNT_OPENAI_API_KEY"),
        ...optionalStringConfig("baseURL", "ACCOUNT_OPENAI_BASE_URL", "OPENAI_BASE_URL"),
        ...optionalStringConfig("organization", "ACCOUNT_OPENAI_ORGANIZATION", "OPENAI_ORGANIZATION"),
        ...optionalStringConfig("project", "ACCOUNT_OPENAI_PROJECT", "OPENAI_PROJECT"),
      };
    case "bedrock":
      return {
        apiKey: firstRequiredEnv("ACCOUNT_BEDROCK_API_KEY"),
        ...optionalStringConfig("region", "ACCOUNT_BEDROCK_REGION", "AWS_REGION"),
        ...optionalStringConfig("accessKeyId", "ACCOUNT_BEDROCK_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"),
        ...optionalStringConfig("secretAccessKey", "ACCOUNT_BEDROCK_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY"),
        ...optionalStringConfig("sessionToken", "ACCOUNT_BEDROCK_SESSION_TOKEN", "AWS_SESSION_TOKEN"),
      };
    case "gateway":
      return { apiKey: firstRequiredEnv("ACCOUNT_GATEWAY_API_KEY") };
  }
}

function accountToolsConfig(provider: AccountModelProviderName): Record<string, Record<string, unknown>> {
  const explicitTools = optionalJsonRecord("ACCOUNT_TOOLS_JSON");
  if (explicitTools) {
    return explicitTools as Record<string, Record<string, unknown>>;
  }

  const tools: Record<string, Record<string, unknown>> = {};

  const tavilyEnabled = envFlag("ACCOUNT_ENABLE_TAVILY_TOOLS", true);
  if (tavilyEnabled) {
    const tavilyApiKey = optionalScriptEnv("ACCOUNT_TAVILY_API_KEY");
    if (tavilyApiKey) {
      tools.tavilySearch = {
        enabled: true,
        apiKey: tavilyApiKey,
      };
      tools.tavilyExtract = {
        enabled: true,
        apiKey: tavilyApiKey,
      };
    }
  }

  if (provider === "google" && envFlag("ACCOUNT_ENABLE_GOOGLE_SEARCH", false)) {
    tools.googleSearch = {
      enabled: true,
      ...optionalJsonRecord("ACCOUNT_GOOGLE_SEARCH_CONFIG_JSON"),
    };
  }

  return Object.fromEntries(
    Object.entries(tools).filter(([, config]) => config.enabled !== false),
  );
}

function optionalJsonRecord(name: string): Record<string, unknown> | undefined {
  const raw = optionalScriptEnv(name);
  if (!raw) {
    return undefined;
  }

  const parsed = parseJson(raw);
  if (!isRecord(parsed)) {
    throw new Error(`${name} must be a JSON object`);
  }

  return parsed;
}

function firstRequiredEnv(name: string): string {
  const value = optionalScriptEnv(name);
  if (value) {
    return value;
  }

  throw new Error(`Missing required environment variable: ${name}`);
}

function envFlag(name: string, defaultValue: boolean): boolean {
  const value = optionalScriptEnv(name);
  if (value === undefined) {
    return defaultValue;
  }

  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function optionalStringConfig(key: string, ...envNames: string[]): Record<string, string> {
  for (const name of envNames) {
    const value = optionalScriptEnv(name);
    if (value) {
      return { [key]: value };
    }
  }

  return {};
}

function optionalNumberConfig(key: string, envName: string): Record<string, number> {
  const value = optionalScriptEnv(envName);
  if (!value) {
    return {};
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${envName} must be a number`);
  }

  return { [key]: parsed };
}

function optionalBooleanConfig(key: string, envName: string): Record<string, boolean> {
  const value = optionalScriptEnv(envName);
  if (!value) {
    return {};
  }

  if (value === "true") return { [key]: true };
  if (value === "false") return { [key]: false };
  throw new Error(`${envName} must be true or false`);
}
