/**
 * Runtime key helpers shared by account-management and harness-processing.
 * Keep account scoping, public direct API validation, leases, and filesystem namespaces here.
 */

import { createHash } from "node:crypto";

const FILESYSTEM_NAMESPACE_PREFIX = "fs-";
const HASH_HEX_LENGTH = 40;
const SUBAGENT_TASK_ID_PREFIX = "subagent~";
const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

export interface AccountAgentScopedKey {
  accountId: string;
  agentId: string;
  key: string;
}

export const INTERNAL_EVENT_ID_PREFIX = "conversation-lease:";
export const DIRECT_API_EVENT_ID_PREFIX = "api:";
export const DIRECT_API_CONVERSATION_PREFIX = "api:";
export const ACCOUNT_NAMESPACE_PREFIX = "acct:";
export const GITHUB_INTEGRATION_PREFIX = "gh:";
export const SLACK_INTEGRATION_PREFIX = "slack:";
export const SLACK_COMMAND_INTEGRATION_PREFIX = "slack-command:";
export const TELEGRAM_INTEGRATION_PREFIX = "tg:";
export const DISCORD_INTEGRATION_PREFIX = "discord:";
export const PANCAKE_INTEGRATION_PREFIX = "pancake:";
export const ZALO_INTEGRATION_PREFIX = "zalo:";

const RESERVED_EVENT_ID_PREFIXES = [
  INTERNAL_EVENT_ID_PREFIX,
  ACCOUNT_NAMESPACE_PREFIX,
  DIRECT_API_EVENT_ID_PREFIX,
  GITHUB_INTEGRATION_PREFIX,
  SLACK_INTEGRATION_PREFIX,
  SLACK_COMMAND_INTEGRATION_PREFIX,
  TELEGRAM_INTEGRATION_PREFIX,
  DISCORD_INTEGRATION_PREFIX,
  PANCAKE_INTEGRATION_PREFIX,
  ZALO_INTEGRATION_PREFIX,
] as const;

const RESERVED_CONVERSATION_PREFIXES = [
  INTERNAL_EVENT_ID_PREFIX,
  ACCOUNT_NAMESPACE_PREFIX,
  DIRECT_API_CONVERSATION_PREFIX,
  GITHUB_INTEGRATION_PREFIX,
  SLACK_INTEGRATION_PREFIX,
  TELEGRAM_INTEGRATION_PREFIX,
  DISCORD_INTEGRATION_PREFIX,
  PANCAKE_INTEGRATION_PREFIX,
  ZALO_INTEGRATION_PREFIX,
] as const;

const CHANNEL_CONVERSATION_PREFIXES = [
  GITHUB_INTEGRATION_PREFIX,
  SLACK_INTEGRATION_PREFIX,
  TELEGRAM_INTEGRATION_PREFIX,
  DISCORD_INTEGRATION_PREFIX,
  PANCAKE_INTEGRATION_PREFIX,
  ZALO_INTEGRATION_PREFIX,
] as const;

export function normalizeFilesystemNamespace(conversationKey: string): string {
  return `${FILESYSTEM_NAMESPACE_PREFIX}${hashScopedValue("filesystem-namespace", conversationKey)}`;
}

export function conversationLeaseKey(conversationKey: string): string {
  return `${INTERNAL_EVENT_ID_PREFIX}${hashScopedValue("conversation-lease", conversationKey)}`;
}

export function channelScopeKeyFromConversation(
  conversationKey: string,
  scope: "channel" | "conversation" = "channel",
): string {
  const unscopedKey = unscopedChannelConversationKey(conversationKey);
  if (scope === "conversation") {
    return unscopedKey;
  }

  if (unscopedKey.startsWith(SLACK_INTEGRATION_PREFIX)) {
    const parts = unscopedKey.split(":");
    return parts.length >= 4 ? parts.slice(0, 3).join(":") : unscopedKey;
  }
  if (unscopedKey.startsWith(DISCORD_INTEGRATION_PREFIX)) {
    const parts = unscopedKey.split(":");
    return parts.length >= 3 ? parts.slice(0, 3).join(":") : unscopedKey;
  }
  if (unscopedKey.startsWith(PANCAKE_INTEGRATION_PREFIX)) {
    const parts = unscopedKey.split(":");
    return parts.length >= 3 ? parts.slice(0, 2).join(":") : unscopedKey;
  }
  if (unscopedKey.startsWith(GITHUB_INTEGRATION_PREFIX)) {
    const parts = unscopedKey.split(":");
    return parts.length >= 2 ? parts.slice(0, 2).join(":") : unscopedKey;
  }

  return unscopedKey;
}

export function normalizeDirectIdentifier(name: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${name} must not be empty`);
  }

  return normalized;
}

export function assertValidPublicEventId(value: string): string {
  const normalized = normalizeDirectIdentifier("eventId", value);
  if (hasReservedEventIdPrefix(normalized)) {
    throw new Error("eventId uses a reserved internal prefix");
  }
  return normalized;
}

export function assertValidPublicConversationKey(value: string): string {
  const normalized = normalizeDirectIdentifier("conversationKey", value);
  if (hasReservedConversationPrefix(normalized)) {
    throw new Error(
      "conversationKey uses a reserved channel or internal prefix",
    );
  }
  return normalized;
}

export function scopedDirectEventId(
  accountId: string,
  agentId: string,
  publicEventId: string,
): string {
  return accountAgentScopedKey(
    accountId,
    agentId,
    `${DIRECT_API_EVENT_ID_PREFIX}${publicEventId}`,
  );
}

export function scopedDirectConversationKey(
  accountId: string,
  agentId: string,
  publicConversationKey: string,
): string {
  return accountAgentScopedKey(
    accountId,
    agentId,
    `${DIRECT_API_CONVERSATION_PREFIX}${publicConversationKey}`,
  );
}

export function publicConversationKeyFromScoped(
  conversationKey: string,
  accountId: string,
  agentId?: string,
): string {
  const accountPrefix = agentId
    ? `acct:${accountId}:agent:${agentId}:`
    : `acct:${accountId}:`;
  const unscoped = conversationKey.startsWith(accountPrefix)
    ? conversationKey.slice(accountPrefix.length)
    : conversationKey;

  return unscoped.replace(/^api:/, "");
}

export function accountScopedKey(accountId: string, key: string): string {
  return `${ACCOUNT_NAMESPACE_PREFIX}${accountId}:${key}`;
}

export function accountAgentScopedKey(
  accountId: string,
  agentId: string,
  key: string,
): string {
  return accountScopedKey(accountId, `agent:${agentId}:${key}`);
}

export function accountScopedPrefix(accountId: string): string {
  return `${ACCOUNT_NAMESPACE_PREFIX}${accountId}:`;
}

export function createSubagentTaskId(
  parentEventId: string,
  taskNonce: string = crypto.randomUUID(),
): string {
  const parentScope = parseAccountAgentScopedKey(parentEventId);
  if (!parentScope) {
    throw new Error("Subagent parent event must be account and agent scoped");
  }
  if (!new RegExp(`^${UUID_PATTERN}$`).test(taskNonce)) {
    throw new Error("Subagent task nonce must be a UUID");
  }

  return `${SUBAGENT_TASK_ID_PREFIX}${Buffer.from(parentEventId, "utf8").toString("base64url")}~${taskNonce}`;
}

export function parseAccountAgentScopedKey(
  value: string,
): AccountAgentScopedKey | null {
  const match = /^acct:([^:]+):agent:([^:]+):(.+)$/.exec(value);
  if (!match?.[1] || !match[2] || !match[3]) {
    return null;
  }

  return {
    accountId: match[1],
    agentId: match[2],
    key: match[3],
  };
}

export function subagentParentEventId(taskId: string): string | null {
  const match = new RegExp(
    `^${SUBAGENT_TASK_ID_PREFIX}([A-Za-z0-9_-]+)~${UUID_PATTERN}$`,
  ).exec(taskId);
  if (!match?.[1]) {
    return null;
  }

  try {
    const decoded = Buffer.from(match[1], "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== match[1]) {
      return null;
    }
    const scope = parseAccountAgentScopedKey(decoded);
    return scope ? decoded : null;
  } catch {
    return null;
  }
}

function hasReservedConversationPrefix(value: string): boolean {
  return RESERVED_CONVERSATION_PREFIXES.some((prefix) =>
    value.startsWith(prefix),
  );
}

function hasReservedEventIdPrefix(value: string): boolean {
  return RESERVED_EVENT_ID_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function unscopedChannelConversationKey(conversationKey: string): string {
  for (const prefix of CHANNEL_CONVERSATION_PREFIXES) {
    const start = conversationKey.indexOf(prefix);
    if (start === 0 || (start > 0 && conversationKey[start - 1] === ":")) {
      return conversationKey.slice(start);
    }
  }
  return conversationKey;
}

function hashScopedValue(scope: string, value: string): string {
  return createHash("sha256")
    .update(scope)
    .update("\0")
    .update(value)
    .digest("hex")
    .slice(0, HASH_HEX_LENGTH);
}
