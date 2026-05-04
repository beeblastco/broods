/**
 * Shared account configuration, auth, and DynamoDB persistence.
 * Keep account-level storage and secret handling here for all Lambdas.
 */

import {
    DeleteItemCommand,
    GetItemCommand,
    PutItemCommand,
    QueryCommand,
    ScanCommand,
    UpdateItemCommand,
    type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
    dynamo,
    fromAttributeValue,
    isConditionalCheckFailed,
    toAttributeValue,
} from "./dynamo.ts";
import { optionalEnv, requireEnv } from "./env.ts";
import {
  accountModelProviderNames,
  isAccountModelProviderName,
  type AccountModelProviderName,
} from "./providers.ts";
export type { AccountModelProviderName } from "./providers.ts";

const ACCOUNT_SECRET_PREFIX = "fp_acct_";
const DEFAULT_ACCOUNT_STATUS = "active";
const CONFIG_ENCRYPTION_ALGORITHM = "aes-256-gcm";
const REDACTED_SECRET_VALUE = "********";
const AGENT_MAX_TURN_LIMIT = 100; // Limit configurate from allowing runaway model/tool loops
const SESSION_MAX_CONTEXT_LENGTH_LIMIT = 500_000; // Limit configured for session max context length

export type AccountStatus = "active" | "disabled";

export interface AccountRecord {
  accountId: string;
  username: string;
  description?: string;
  secretHash: string;
  status: AccountStatus;
  config: AccountConfig;
  createdAt: string;
  updatedAt: string;
}

export interface AccountConfig {
  agent?: AccountAgentConfig;
  model?: AccountModelConfig;
  provider?: AccountProviderConfig;
  workspace?: AccountWorkspaceConfig;
  session?: AccountSessionConfig;
  channels?: AccountChannelsConfig;
  tools?: AccountToolsConfig;
  [key: string]: unknown;
}

export interface AccountAgentConfig {
  maxTurn?: number;
  system?: string;
  [key: string]: unknown;
}

export interface AccountModelConfig {
  provider?: AccountModelProviderName;
  modelId?: string;
  options?: Record<string, unknown>;
  [key: string]: unknown;
}

export type AccountProviderConfig = Partial<Record<AccountModelProviderName, AccountProviderSettings>>;

export interface AccountProviderSettings {
  [key: string]: unknown;
}

export interface AccountWorkspaceConfig {
  enabled?: boolean;
  memory?: AccountWorkspaceMemoryConfig;
  [key: string]: unknown;
}

export interface AccountWorkspaceMemoryConfig {
  namespace?: string;
  [key: string]: unknown;
}

export interface AccountSessionConfig {
  pruning?: AccountSessionPruningConfig;
  compaction?: AccountSessionCompactionConfig;
  [key: string]: unknown;
}

export interface AccountSessionPruningConfig {
  enabled?: boolean;
  [key: string]: unknown;
}

export interface AccountSessionCompactionConfig {
  enabled?: boolean;
  maxContextLength?: number;
  [key: string]: unknown;
}

export type AccountToolsConfig = Record<string, AccountToolConfig>;

export interface AccountToolConfig {
  enabled?: boolean;
  [key: string]: unknown;
}

export interface AccountChannelsConfig {
  telegram?: TelegramAccountConfig;
  github?: GitHubAccountConfig;
  slack?: SlackAccountConfig;
  discord?: DiscordAccountConfig;
  [key: string]: unknown;
}

export interface TelegramAccountConfig {
  botToken?: string;
  webhookSecret?: string;
  allowedChatIds?: number[];
  reactionEmoji?: string;
  [key: string]: unknown;
}

export interface GitHubAccountConfig {
  webhookSecret?: string;
  appId?: string;
  privateKey?: string;
  allowedRepos?: string[];
  [key: string]: unknown;
}

export interface SlackAccountConfig {
  botToken?: string;
  signingSecret?: string;
  allowedChannelIds?: string[];
  [key: string]: unknown;
}

export interface DiscordAccountConfig {
  botToken?: string;
  publicKey?: string;
  allowedGuildIds?: string[];
  [key: string]: unknown;
}

export type AuthContext =
  | { kind: "admin" }
  | { kind: "account"; account: AccountRecord };

export interface PublicAccountRecord {
  accountId: string;
  username: string;
  description?: string;
  status: AccountStatus;
  config: AccountConfig;
  createdAt: string;
  updatedAt: string;
}

interface EncryptedAccountConfig {
    encrypted: true;
    algorithm: typeof CONFIG_ENCRYPTION_ALGORITHM;
    iv: string;
    tag: string;
    ciphertext: string;
}

export interface CreateAccountInput {
  username: string;
  description?: string;
  config?: unknown;
}

export interface UpdateAccountInput {
  username?: string;
  description?: string | null;
  config?: unknown;
}

type AccountConfigPatch = Record<string, unknown>;

export function createAccountId(): string {
  return `acct_${randomBytes(12).toString("hex")}`;
}

export function createAccountSecret(): string {
  return `${ACCOUNT_SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function hashAccountSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function extractBearerToken(authorization: string | undefined): string | null {
  if (!authorization) {
    return null;
  }

  const [scheme, token, ...rest] = authorization.trim().split(/\s+/);
  if (rest.length > 0 || !scheme || !token || scheme.toLowerCase() !== "bearer") {
    return null;
  }

  return token;
}

export async function resolveBearerAuth(headers: Record<string, string>): Promise<AuthContext | null> {
  const token = extractBearerToken(headers.authorization);
  if (!token) {
    return null;
  }

  const adminSecret = optionalEnv("ADMIN_ACCOUNT_SECRET");
  if (adminSecret && timingSafeStringEqual(token, adminSecret)) {
    return { kind: "admin" };
  }

  const account = await getAccountBySecret(token);
  if (!account || account.status !== "active") {
    return null;
  }

  return { kind: "account", account };
}

export async function createAccount(input: CreateAccountInput): Promise<{
  account: AccountRecord;
  accountSecret: string;
}> {
  const normalizedInput = normalizeCreateAccountInput(input);
  const accountId = createAccountId();
  const accountSecret = createAccountSecret();
  const now = new Date().toISOString();
  const account: AccountRecord = {
    accountId,
    username: normalizedInput.username,
    ...(normalizedInput.description ? { description: normalizedInput.description } : {}),
    secretHash: hashAccountSecret(accountSecret),
    status: DEFAULT_ACCOUNT_STATUS,
    config: normalizeAccountConfig(normalizedInput.config),
    createdAt: now,
    updatedAt: now,
  };

  try {
    await dynamo.send(new PutItemCommand({
      TableName: accountConfigsTableName(),
      Item: accountToItem(account),
      ConditionExpression: "attribute_not_exists(accountId)",
    }));
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      return createAccount(input);
    }
    throw err;
  }

  return { account, accountSecret };
}

export async function getAccount(accountId: string): Promise<AccountRecord | null> {
  const result = await dynamo.send(new GetItemCommand({
    TableName: accountConfigsTableName(),
    Key: { accountId: { S: accountId } },
    ConsistentRead: true,
  }));

  return result.Item ? itemToAccount(result.Item) : null;
}

export async function getAccountBySecret(secret: string): Promise<AccountRecord | null> {
  const result = await dynamo.send(new QueryCommand({
    TableName: accountConfigsTableName(),
    IndexName: accountSecretIndexName(),
    KeyConditionExpression: "secretHash = :secretHash",
    ExpressionAttributeValues: {
      ":secretHash": { S: hashAccountSecret(secret) },
    },
    Limit: 1,
  }));

  const item = result.Items?.[0];
  return item ? itemToAccount(item) : null;
}

export async function listAccounts(): Promise<AccountRecord[]> {
  const result = await dynamo.send(new ScanCommand({
    TableName: accountConfigsTableName(),
  }));

  return (result.Items ?? [])
    .map(itemToAccount)
    .filter((account): account is AccountRecord => account !== null);
}

export async function updateAccount(
    accountId: string,
    input: UpdateAccountInput,
): Promise<AccountRecord | null> {
    const existing = await getAccount(accountId);
    if (!existing) {
        return null;
    }

    const normalizedInput = normalizeUpdateAccountInput(input);
    const mergedConfig = normalizedInput.config === undefined
        ? existing.config
        : mergeAccountConfig(existing.config, normalizeAccountConfigPatch(normalizedInput.config));
    const setExpressions = [
        "#config = :config",
        "updatedAt = :updatedAt",
        ...(normalizedInput.username !== undefined ? ["username = :username"] : []),
        ...(normalizedInput.description !== undefined && normalizedInput.description !== null
            ? ["description = :description"]
            : []),
    ];
    const removeExpressions = normalizedInput.description === null ? ["description"] : [];
    const result = await dynamo.send(new UpdateItemCommand({
        TableName: accountConfigsTableName(),
        Key: { accountId: { S: accountId } },
        UpdateExpression: [
            `SET ${setExpressions.join(", ")}`,
            ...(removeExpressions.length > 0 ? [`REMOVE ${removeExpressions.join(", ")}`] : []),
        ].join(" "),
        ConditionExpression: "attribute_exists(accountId)",
        ExpressionAttributeNames: {
            "#config": "config",
        },
        ExpressionAttributeValues: {
            ":config": toAttributeValue(encryptAccountConfig(mergedConfig)),
            ":updatedAt": { S: new Date().toISOString() },
            ...(normalizedInput.username !== undefined ? { ":username": { S: normalizedInput.username } } : {}),
            ...(normalizedInput.description !== undefined && normalizedInput.description !== null
                ? { ":description": { S: normalizedInput.description } }
                : {}),
        },
        ReturnValues: "ALL_NEW",
    })).catch((err) => {
        if (isConditionalCheckFailed(err)) {
            return null;
        }
        throw err;
    });

    return result?.Attributes ? itemToAccount(result.Attributes) : null;
}

export async function rotateAccountSecret(accountId: string): Promise<{
  account: AccountRecord;
  accountSecret: string;
} | null> {
  const accountSecret = createAccountSecret();
  const result = await dynamo.send(new UpdateItemCommand({
    TableName: accountConfigsTableName(),
    Key: { accountId: { S: accountId } },
    UpdateExpression: "SET secretHash = :secretHash, updatedAt = :updatedAt",
    ConditionExpression: "attribute_exists(accountId)",
    ExpressionAttributeValues: {
      ":secretHash": { S: hashAccountSecret(accountSecret) },
      ":updatedAt": { S: new Date().toISOString() },
    },
    ReturnValues: "ALL_NEW",
  })).catch((err) => {
    if (isConditionalCheckFailed(err)) {
      return null;
    }
    throw err;
  });

  const account = result?.Attributes ? itemToAccount(result.Attributes) : null;
  return account ? { account, accountSecret } : null;
}

export async function deleteAccount(accountId: string): Promise<boolean> {
  const result = await dynamo.send(new DeleteItemCommand({
    TableName: accountConfigsTableName(),
    Key: { accountId: { S: accountId } },
    ConditionExpression: "attribute_exists(accountId)",
  })).catch((err) => {
    if (isConditionalCheckFailed(err)) {
      return false;
    }
    throw err;
  });

  return result !== false;
}

export function toPublicAccount(account: AccountRecord): PublicAccountRecord {
  return {
    accountId: account.accountId,
    username: account.username,
    ...(account.description ? { description: account.description } : {}),
    status: account.status,
    config: redactAccountConfig(account.config),
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

export function toRuntimeAccountConfig(config: AccountConfig): AccountConfig {
  const {
    agent,
    model,
    provider,
    workspace,
    session,
    tools,
  } = config;

  return normalizeAccountConfig({
    ...(agent !== undefined ? { agent } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(workspace !== undefined ? { workspace } : {}),
    ...(session !== undefined ? { session } : {}),
    ...(tools !== undefined ? { tools } : {}),
  });
}

export function normalizeAccountConfig(value: unknown): AccountConfig {
  if (value == null) {
    return {};
  }

  if (!isPlainObject(value)) {
    throw new Error("config must be an object");
  }

  const config = value as Record<string, unknown>;
  normalizeAgentConfig(config.agent);
  normalizeModelConfig(config.model);
  normalizeProviderConfig(config.provider);
  normalizeWorkspaceConfig(config.workspace);
  normalizeSessionConfig(config.session);
  normalizeChannelsConfig(config.channels);
  normalizeToolsConfig(config.tools);

  return config as AccountConfig;
}

export function normalizeAccountConfigPatch(value: unknown): AccountConfigPatch {
  if (!isPlainObject(value)) {
    throw new Error("config must be an object");
  }

  validateConfigPatch(value, "config");
  return value;
}

function normalizeCreateAccountInput(value: unknown): Required<Pick<CreateAccountInput, "username">> & {
  description?: string;
  config?: unknown;
} {
  if (!isPlainObject(value)) {
    throw new Error("Request body must include username");
  }

  const username = normalizeRequiredString(value.username, "username");
  const description = normalizeOptionalString(value.description, "description");
  return {
    username,
    ...(description ? { description } : {}),
    config: value.config ?? {},
  };
}

function normalizeUpdateAccountInput(value: UpdateAccountInput): UpdateAccountInput {
  if (!isPlainObject(value)) {
    throw new Error("Request body must be an object");
  }

  return {
    ...(value.username !== undefined
      ? { username: normalizeRequiredString(value.username, "username") }
      : {}),
    ...(value.description !== undefined
      ? { description: value.description === null ? null : normalizeOptionalString(value.description, "description") }
      : {}),
    ...("config" in value ? { config: value.config } : {}),
  };
}

function normalizeChannelsConfig(value: unknown): void {
  if (value == null) {
    return;
  }
  if (!isPlainObject(value)) {
    throw new Error("config.channels must be an object");
  }

  const channels = value as Record<string, unknown>;
  normalizeTelegramConfig(channels.telegram);
  normalizeGitHubConfig(channels.github);
  normalizeSlackConfig(channels.slack);
  normalizeDiscordConfig(channels.discord);
}

function normalizeAgentConfig(value: unknown): void {
  if (value == null) {
    return;
  }
  if (!isPlainObject(value)) {
    throw new Error("config.agent must be an object");
  }

  const config = value as Record<string, unknown>;
  assertOptionalPositiveInteger(config.maxTurn, "config.agent.maxTurn", AGENT_MAX_TURN_LIMIT);
  assertOptionalString(config.system, "config.agent.system");
}

function normalizeModelConfig(value: unknown): void {
  if (value == null) {
    return;
  }
  if (!isPlainObject(value)) {
    throw new Error("config.model must be an object");
  }

  const config = value as Record<string, unknown>;
  assertOptionalProviderName(config.provider, "config.model.provider");
  assertOptionalString(config.modelId, "config.model.modelId");
  if (config.options !== undefined && !isPlainObject(config.options)) {
    throw new Error("config.model.options must be an object");
  }
}

function normalizeProviderConfig(value: unknown): void {
  if (value == null) {
    return;
  }
  if (!isPlainObject(value)) {
    throw new Error("config.provider must be an object");
  }

  for (const [providerName, providerConfig] of Object.entries(value)) {
    if (!isAccountModelProviderName(providerName)) {
      throw new Error(`config.provider.${providerName} is not a supported provider`);
    }
    normalizeProviderSettings(providerName, providerConfig);
  }
}

function normalizeProviderSettings(providerName: AccountModelProviderName, value: unknown): void {
  if (!isPlainObject(value)) {
    throw new Error(`config.provider.${providerName} must be an object`);
  }

  const config = value as Record<string, unknown>;
  assertOptionalString(config.apiKey, `config.provider.${providerName}.apiKey`);
  assertOptionalString(config.baseURL, `config.provider.${providerName}.baseURL`);
  if (config.headers !== undefined && !isStringRecord(config.headers)) {
    throw new Error(`config.provider.${providerName}.headers must be an object with string values`);
  }

  if (providerName === "openai") {
    assertOptionalString(config.organization, "config.provider.openai.organization");
    assertOptionalString(config.project, "config.provider.openai.project");
    assertOptionalString(config.name, "config.provider.openai.name");
  }

  if (providerName === "bedrock") {
    assertOptionalString(config.region, "config.provider.bedrock.region");
    assertOptionalString(config.accessKeyId, "config.provider.bedrock.accessKeyId");
    assertOptionalString(config.secretAccessKey, "config.provider.bedrock.secretAccessKey");
    assertOptionalString(config.sessionToken, "config.provider.bedrock.sessionToken");
  }
}

function normalizeWorkspaceConfig(value: unknown): void {
  if (value == null) {
    return;
  }
  if (!isPlainObject(value)) {
    throw new Error("config.workspace must be an object");
  }

  const config = value as Record<string, unknown>;
  assertOptionalBoolean(config.enabled, "config.workspace.enabled");
  normalizeWorkspaceMemoryConfig(config.memory);
}

function normalizeWorkspaceMemoryConfig(value: unknown): void {
  if (value == null) {
    return;
  }
  if (!isPlainObject(value)) {
    throw new Error("config.workspace.memory must be an object");
  }

  const config = value as Record<string, unknown>;
  assertOptionalNonEmptyString(config.namespace, "config.workspace.memory.namespace");
}

function normalizeSessionConfig(value: unknown): void {
  if (value == null) {
    return;
  }
  if (!isPlainObject(value)) {
    throw new Error("config.session must be an object");
  }

  const config = value as Record<string, unknown>;
  normalizeSessionPruningConfig(config.pruning);
  normalizeSessionCompactionConfig(config.compaction);
}

function normalizeSessionPruningConfig(value: unknown): void {
  if (value == null) {
    return;
  }
  if (!isPlainObject(value)) {
    throw new Error("config.session.pruning must be an object");
  }

  const config = value as Record<string, unknown>;
  assertOptionalBoolean(config.enabled, "config.session.pruning.enabled");
}

function normalizeSessionCompactionConfig(value: unknown): void {
  if (value == null) {
    return;
  }
  if (!isPlainObject(value)) {
    throw new Error("config.session.compaction must be an object");
  }

  const config = value as Record<string, unknown>;
  assertOptionalBoolean(config.enabled, "config.session.compaction.enabled");
  assertOptionalPositiveInteger(
    config.maxContextLength,
    "config.session.compaction.maxContextLength",
    SESSION_MAX_CONTEXT_LENGTH_LIMIT,
  );
}

function normalizeToolsConfig(value: unknown): void {
  if (value == null) {
    return;
  }
  if (!isPlainObject(value)) {
    throw new Error("config.tools must be an object");
  }

  for (const [toolName, toolConfig] of Object.entries(value)) {
    normalizeToolConfig(toolName, toolConfig);
  }
}

function normalizeToolConfig(toolName: string, value: unknown): void {
  if (!isPlainObject(value)) {
    throw new Error(`config.tools.${toolName} must be an object`);
  }

  if (!isSupportedConfigToolName(toolName)) {
    throw new Error(`config.tools.${toolName} is not a supported tool`);
  }

  const config = value as Record<string, unknown>;
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
    throw new Error(`config.tools.${toolName}.enabled must be a boolean`);
  }

  switch (toolName) {
    case "tavilySearch":
      normalizeTavilySearchToolConfig(config);
      return;
    case "tavilyExtract":
      normalizeTavilyExtractToolConfig(config);
      return;
    case "googleSearch":
      normalizeGoogleSearchToolConfig(config);
      return;
  }
}

function isSupportedConfigToolName(toolName: string): toolName is "tavilySearch" | "tavilyExtract" | "googleSearch" {
  return toolName === "tavilySearch" || toolName === "tavilyExtract" || toolName === "googleSearch";
}

function normalizeTavilySearchToolConfig(config: Record<string, unknown>): void {
  assertOptionalEnum(config.searchDepth, "config.tools.tavilySearch.searchDepth", ["basic", "advanced"]);
  assertOptionalBoolean(config.includeAnswer, "config.tools.tavilySearch.includeAnswer");
  assertOptionalPositiveInteger(config.maxResults, "config.tools.tavilySearch.maxResults", 20);
  assertOptionalEnum(config.topic, "config.tools.tavilySearch.topic", ["general", "news", "finance"]);
}

function normalizeTavilyExtractToolConfig(config: Record<string, unknown>): void {
  assertOptionalEnum(config.extractDepth, "config.tools.tavilyExtract.extractDepth", ["basic", "advanced"]);
  assertOptionalEnum(config.format, "config.tools.tavilyExtract.format", ["markdown", "text"]);
}

function normalizeGoogleSearchToolConfig(config: Record<string, unknown>): void {
  if (config.searchTypes !== undefined) {
    if (!isPlainObject(config.searchTypes)) {
      throw new Error("config.tools.googleSearch.searchTypes must be an object");
    }
    const searchTypes = config.searchTypes as Record<string, unknown>;
    if (searchTypes.webSearch !== undefined && !isPlainObject(searchTypes.webSearch)) {
      throw new Error("config.tools.googleSearch.searchTypes.webSearch must be an object");
    }
    if (searchTypes.imageSearch !== undefined && !isPlainObject(searchTypes.imageSearch)) {
      throw new Error("config.tools.googleSearch.searchTypes.imageSearch must be an object");
    }
  }

  if (config.timeRangeFilter !== undefined) {
    if (!isPlainObject(config.timeRangeFilter)) {
      throw new Error("config.tools.googleSearch.timeRangeFilter must be an object");
    }
    const timeRangeFilter = config.timeRangeFilter as Record<string, unknown>;
    assertOptionalString(timeRangeFilter.startTime, "config.tools.googleSearch.timeRangeFilter.startTime");
    assertOptionalString(timeRangeFilter.endTime, "config.tools.googleSearch.timeRangeFilter.endTime");
  }
}

function validateConfigPatch(value: unknown, path: string): void {
  if (!isPlainObject(value)) {
    throw new Error(`${path} must be an object`);
  }

  const candidate = value as Record<string, unknown>;
  const withoutNulls = removeNullConfigValues(candidate);

  if (path === "config") {
    normalizeAccountConfig(withoutNulls);
    return;
  }

  for (const [key, entry] of Object.entries(candidate)) {
    if (entry == null || Array.isArray(entry) || !isPlainObject(entry)) {
      continue;
    }

    validateConfigPatch(entry, `${path}.${key}`);
  }
}

function removeNullConfigValues(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      if (entry === null) {
        return [];
      }
      if (isPlainObject(entry)) {
        return [[key, removeNullConfigValues(entry)]];
      }
      return [[key, entry]];
    }),
  );
}

function normalizeTelegramConfig(value: unknown): void {
  if (value == null) return;
  if (!isPlainObject(value)) throw new Error("config.channels.telegram must be an object");
  const config = value as Record<string, unknown>;
  assertOptionalString(config.botToken, "config.channels.telegram.botToken");
  assertOptionalString(config.webhookSecret, "config.channels.telegram.webhookSecret");
  assertOptionalNumberArray(config.allowedChatIds, "config.channels.telegram.allowedChatIds");
  assertOptionalString(config.reactionEmoji, "config.channels.telegram.reactionEmoji");
}

function normalizeGitHubConfig(value: unknown): void {
  if (value == null) return;
  if (!isPlainObject(value)) throw new Error("config.channels.github must be an object");
  const config = value as Record<string, unknown>;
  assertOptionalString(config.webhookSecret, "config.channels.github.webhookSecret");
  assertOptionalString(config.appId, "config.channels.github.appId");
  assertOptionalString(config.privateKey, "config.channels.github.privateKey");
  assertOptionalStringArray(config.allowedRepos, "config.channels.github.allowedRepos");
}

function normalizeSlackConfig(value: unknown): void {
  if (value == null) return;
  if (!isPlainObject(value)) throw new Error("config.channels.slack must be an object");
  const config = value as Record<string, unknown>;
  assertOptionalString(config.botToken, "config.channels.slack.botToken");
  assertOptionalString(config.signingSecret, "config.channels.slack.signingSecret");
  assertOptionalStringArray(config.allowedChannelIds, "config.channels.slack.allowedChannelIds");
}

function normalizeDiscordConfig(value: unknown): void {
  if (value == null) return;
  if (!isPlainObject(value)) throw new Error("config.channels.discord must be an object");
  const config = value as Record<string, unknown>;
  assertOptionalString(config.botToken, "config.channels.discord.botToken");
  assertOptionalString(config.publicKey, "config.channels.discord.publicKey");
  assertOptionalStringArray(config.allowedGuildIds, "config.channels.discord.allowedGuildIds");
}

function accountConfigsTableName(): string {
  return requireEnv("ACCOUNT_CONFIGS_TABLE_NAME");
}

function accountSecretIndexName(): string {
  return optionalEnv("ACCOUNT_SECRET_INDEX_NAME") ?? "SecretHashIndex";
}

function accountToItem(account: AccountRecord): Record<string, AttributeValue> {
  return {
    accountId: { S: account.accountId },
    username: { S: account.username },
    ...(account.description ? { description: { S: account.description } } : {}),
    secretHash: { S: account.secretHash },
    status: { S: account.status },
    config: toAttributeValue(encryptAccountConfig(account.config)),
    createdAt: { S: account.createdAt },
    updatedAt: { S: account.updatedAt },
  };
}

function itemToAccount(item: Record<string, AttributeValue>): AccountRecord | null {
  const accountId = item.accountId?.S;
  const username = item.username?.S ?? accountId;
  const description = item.description?.S;
  const secretHash = item.secretHash?.S;
  const status = item.status?.S;
  const createdAt = item.createdAt?.S;
  const updatedAt = item.updatedAt?.S;

  if (!accountId || !username || !secretHash || !isAccountStatus(status) || !createdAt || !updatedAt) {
    return null;
  }

  return {
    accountId,
    username,
    ...(description ? { description } : {}),
    secretHash,
    status,
    config: decodeStoredAccountConfig(item.config ? fromAttributeValue(item.config) : {}),
    createdAt,
    updatedAt,
  };
}

function isAccountStatus(value: string | undefined): value is AccountStatus {
  return value === "active" || value === "disabled";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isPlainObject(value) &&
    Object.values(value).every((entry) => typeof entry === "string");
}

function assertOptionalString(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
}

function assertOptionalProviderName(value: unknown, name: string): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string" || !isAccountModelProviderName(value)) {
    throw new Error(`${name} must be one of: ${accountModelProviderNames().join(", ")}`);
  }
}

function assertOptionalBoolean(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean`);
  }
}

function assertOptionalEnum<T extends string>(value: unknown, name: string, allowed: readonly T[]): void {
  if (value !== undefined && (typeof value !== "string" || !allowed.includes(value as T))) {
    throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  }
}

function normalizeRequiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }

  return value.trim();
}

function normalizeOptionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function assertOptionalNonEmptyString(value: unknown, name: string): void {
  assertOptionalString(value, name);
  if (typeof value === "string" && value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
}

function assertOptionalPositiveInteger(value: unknown, name: string, max: number): void {
  if (value === undefined) {
    return;
  }

  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > max
  ) {
    throw new Error(`${name} must be an integer from 1 to ${max}`);
  }
}

function assertOptionalStringArray(value: unknown, name: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`${name} must be an array of strings`);
  }
}

function assertOptionalNumberArray(value: unknown, name: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || !value.every((entry) => Number.isFinite(entry) && typeof entry === "number")) {
    throw new Error(`${name} must be an array of numbers`);
  }
}

function timingSafeStringEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);

  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function decodeStoredAccountConfig(value: unknown): AccountConfig {
    if (isEncryptedAccountConfig(value)) {
        return decryptAccountConfig(value);
    }

    throw new Error("Stored account config must be encrypted");
}

function encryptAccountConfig(config: AccountConfig): EncryptedAccountConfig {
    const iv = randomBytes(12);
    const cipher = createCipheriv(CONFIG_ENCRYPTION_ALGORITHM, accountConfigEncryptionKey(), iv);
    const plaintext = JSON.stringify(config);
    const ciphertext = Buffer.concat([
        cipher.update(plaintext, "utf-8"),
        cipher.final(),
    ]);

    return {
        encrypted: true,
        algorithm: CONFIG_ENCRYPTION_ALGORITHM,
        iv: iv.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
    };
}

function decryptAccountConfig(config: EncryptedAccountConfig): AccountConfig {
    const decipher = createDecipheriv(
        CONFIG_ENCRYPTION_ALGORITHM,
        accountConfigEncryptionKey(),
        Buffer.from(config.iv, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(config.tag, "base64url"));
    const plaintext = Buffer.concat([
        decipher.update(Buffer.from(config.ciphertext, "base64url")),
        decipher.final(),
    ]).toString("utf-8");

    return normalizeAccountConfig(JSON.parse(plaintext));
}

function accountConfigEncryptionKey(): Buffer {
    return createHash("sha256")
        .update(requireEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET"))
        .digest();
}

function isEncryptedAccountConfig(value: unknown): value is EncryptedAccountConfig {
    if (!isPlainObject(value)) {
        return false;
    }

    return value.encrypted === true &&
        value.algorithm === CONFIG_ENCRYPTION_ALGORITHM &&
        typeof value.iv === "string" &&
        typeof value.tag === "string" &&
        typeof value.ciphertext === "string";
}

export function mergeAccountConfig(existing: AccountConfig, patch: AccountConfigPatch): AccountConfig {
    return normalizeAccountConfig(mergeConfigValue(existing, patch));
}

function mergeConfigValue(existing: unknown, patch: unknown): unknown {
    if (patch === undefined) {
        return existing;
    }

    if (patch === REDACTED_SECRET_VALUE) {
        return existing;
    }

    if (patch === null) {
        return undefined;
    }

    if (Array.isArray(patch) || !isPlainObject(patch)) {
        return patch;
    }

    const existingObject = isPlainObject(existing) ? existing : {};
    const merged = { ...existingObject };
    for (const [key, value] of Object.entries(patch)) {
        const mergedValue = mergeConfigValue(existingObject[key], value);
        if (mergedValue === undefined) {
            delete merged[key];
        } else {
            merged[key] = mergedValue;
        }
    }

    return merged;
}

function redactAccountConfig(config: AccountConfig): AccountConfig {
  return redactSecrets(config) as AccountConfig;
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }

  if (!isPlainObject(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      isSecretConfigKey(key) && typeof entry === "string" ? REDACTED_SECRET_VALUE : redactSecrets(entry),
    ]),
  );
}

function isSecretConfigKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized.includes("secret") ||
    normalized.includes("token") ||
    normalized.includes("privatekey") ||
    normalized === "apikey" ||
    normalized === "api_key";
}
