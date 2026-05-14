/**
 * Runtime key helpers shared by account-management and harness-processing.
 * Keep account scoping, public direct API validation, leases, and filesystem namespaces here.
 */

import { createHash } from "node:crypto";

const FILESYSTEM_NAMESPACE_PREFIX = "fs-";
const HASH_HEX_LENGTH = 40;

export const INTERNAL_EVENT_ID_PREFIX = "conversation-lease:";
export const DIRECT_API_EVENT_ID_PREFIX = "api:";
export const DIRECT_API_CONVERSATION_PREFIX = "api:";
export const ACCOUNT_NAMESPACE_PREFIX = "acct:";
export const GITHUB_INTEGRATION_PREFIX = "gh:";
export const SLACK_INTEGRATION_PREFIX = "slack:";
export const SLACK_COMMAND_INTEGRATION_PREFIX = "slack-command:";
export const TELEGRAM_INTEGRATION_PREFIX = "tg:";
export const DISCORD_INTEGRATION_PREFIX = "discord:";

const RESERVED_EVENT_ID_PREFIXES = [
  INTERNAL_EVENT_ID_PREFIX,
  ACCOUNT_NAMESPACE_PREFIX,
  DIRECT_API_EVENT_ID_PREFIX,
  GITHUB_INTEGRATION_PREFIX,
  SLACK_INTEGRATION_PREFIX,
  SLACK_COMMAND_INTEGRATION_PREFIX,
  TELEGRAM_INTEGRATION_PREFIX,
  DISCORD_INTEGRATION_PREFIX,
] as const;

const RESERVED_CONVERSATION_PREFIXES = [
  INTERNAL_EVENT_ID_PREFIX,
  ACCOUNT_NAMESPACE_PREFIX,
  DIRECT_API_CONVERSATION_PREFIX,
  GITHUB_INTEGRATION_PREFIX,
  SLACK_INTEGRATION_PREFIX,
  TELEGRAM_INTEGRATION_PREFIX,
  DISCORD_INTEGRATION_PREFIX,
] as const;

export function normalizeFilesystemNamespace(conversationKey: string): string {
  return `${FILESYSTEM_NAMESPACE_PREFIX}${hashScopedValue("filesystem-namespace", conversationKey)}`;
}

export function conversationLeaseKey(conversationKey: string): string {
  return `${INTERNAL_EVENT_ID_PREFIX}${hashScopedValue("conversation-lease", conversationKey)}`;
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
    throw new Error("conversationKey uses a reserved channel or internal prefix");
  }
  return normalized;
}

export function scopedDirectEventId(accountId: string, agentId: string, publicEventId: string): string {
  return accountAgentScopedKey(accountId, agentId, `${DIRECT_API_EVENT_ID_PREFIX}${publicEventId}`);
}

export function scopedDirectConversationKey(accountId: string, agentId: string, publicConversationKey: string): string {
  return accountAgentScopedKey(accountId, agentId, `${DIRECT_API_CONVERSATION_PREFIX}${publicConversationKey}`);
}

export function publicConversationKeyFromScoped(conversationKey: string, accountId: string, agentId?: string): string {
  const accountPrefix = agentId ? `acct:${accountId}:agent:${agentId}:` : `acct:${accountId}:`;
  const unscoped = conversationKey.startsWith(accountPrefix)
    ? conversationKey.slice(accountPrefix.length)
    : conversationKey;

  return unscoped.replace(/^api:/, "");
}

export function accountScopedKey(accountId: string, key: string): string {
  return `${ACCOUNT_NAMESPACE_PREFIX}${accountId}:${key}`;
}

export function accountAgentScopedKey(accountId: string, agentId: string, key: string): string {
  return accountScopedKey(accountId, `agent:${agentId}:${key}`);
}

export function accountScopedPrefix(accountId: string): string {
  return `${ACCOUNT_NAMESPACE_PREFIX}${accountId}:`;
}

function hasReservedConversationPrefix(value: string): boolean {
  return RESERVED_CONVERSATION_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function hasReservedEventIdPrefix(value: string): boolean {
  return RESERVED_EVENT_ID_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function hashScopedValue(scope: string, value: string): string {
  return createHash("sha256")
    .update(scope)
    .update("\0")
    .update(value)
    .digest("hex")
    .slice(0, HASH_HEX_LENGTH);
}
