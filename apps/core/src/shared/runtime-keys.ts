import { USER_CONVERSATION_PREFIX } from "@broods/convex/model/userToken";
import { createHash } from "node:crypto";

const FILESYSTEM_NAMESPACE_PREFIX = "fs-";
const HASH_HEX_LENGTH = 40;
const RUN_ID_PREFIX = "run_";
const SUBAGENT_TASK_ID_PREFIX = "subagent~";
const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
// Composed from the constants above, never from caller input.
const UUID_EXACT = new RegExp(`^${UUID_PATTERN}$`);
const SUBAGENT_TASK_ID = new RegExp(
  `^${SUBAGENT_TASK_ID_PREFIX}([A-Za-z0-9_-]+)~(${UUID_PATTERN})$`,
);
const RUN_ID = new RegExp(`^${RUN_ID_PREFIX}[0-9a-f]{32}$`);

export const INTERNAL_EVENT_ID_PREFIX = "conversation-lease:";
export const DIRECT_API_EVENT_ID_PREFIX = "api:";
export const DIRECT_API_CONVERSATION_PREFIX = "api:";
export const ACCOUNT_NAMESPACE_PREFIX = "acct:";
// Splits a thread from a channel id that carries colons; only read under a channel prefix.
export const CHANNEL_THREAD_SEPARATOR = "|";
export const GCHAT_INTEGRATION_PREFIX = "gchat:";
export const GITHUB_INTEGRATION_PREFIX = "gh:";
export const LINEAR_INTEGRATION_PREFIX = "linear:";
export const SLACK_INTEGRATION_PREFIX = "slack:";
export const SLACK_COMMAND_INTEGRATION_PREFIX = "slack-command:";
export const TEAMS_INTEGRATION_PREFIX = "teams:";
export const TELEGRAM_INTEGRATION_PREFIX = "tg:";
export const TWILIO_INTEGRATION_PREFIX = "twilio:";
export const DISCORD_INTEGRATION_PREFIX = "discord:";
export const PANCAKE_INTEGRATION_PREFIX = "pancake:";
export const ZALO_INTEGRATION_PREFIX = "zalo:";
export const MATRIX_INTEGRATION_PREFIX = "matrix:";
export const INSTAGRAM_INTEGRATION_PREFIX = "instagram:";
export const MESSENGER_INTEGRATION_PREFIX = "messenger:";
export const WHATSAPP_INTEGRATION_PREFIX = "whatsapp:";

const RESERVED_EVENT_ID_PREFIXES = [
  USER_CONVERSATION_PREFIX,
  INTERNAL_EVENT_ID_PREFIX,
  ACCOUNT_NAMESPACE_PREFIX,
  DIRECT_API_EVENT_ID_PREFIX,
  GCHAT_INTEGRATION_PREFIX,
  GITHUB_INTEGRATION_PREFIX,
  LINEAR_INTEGRATION_PREFIX,
  SLACK_INTEGRATION_PREFIX,
  SLACK_COMMAND_INTEGRATION_PREFIX,
  TEAMS_INTEGRATION_PREFIX,
  TELEGRAM_INTEGRATION_PREFIX,
  TWILIO_INTEGRATION_PREFIX,
  DISCORD_INTEGRATION_PREFIX,
  PANCAKE_INTEGRATION_PREFIX,
  SUBAGENT_TASK_ID_PREFIX,
  ZALO_INTEGRATION_PREFIX,
  MATRIX_INTEGRATION_PREFIX,
  INSTAGRAM_INTEGRATION_PREFIX,
  MESSENGER_INTEGRATION_PREFIX,
  WHATSAPP_INTEGRATION_PREFIX,
] as const;

const RESERVED_CONVERSATION_PREFIXES = [
  USER_CONVERSATION_PREFIX,
  INTERNAL_EVENT_ID_PREFIX,
  ACCOUNT_NAMESPACE_PREFIX,
  DIRECT_API_CONVERSATION_PREFIX,
  GCHAT_INTEGRATION_PREFIX,
  GITHUB_INTEGRATION_PREFIX,
  LINEAR_INTEGRATION_PREFIX,
  SLACK_INTEGRATION_PREFIX,
  TEAMS_INTEGRATION_PREFIX,
  TELEGRAM_INTEGRATION_PREFIX,
  TWILIO_INTEGRATION_PREFIX,
  DISCORD_INTEGRATION_PREFIX,
  PANCAKE_INTEGRATION_PREFIX,
  ZALO_INTEGRATION_PREFIX,
  MATRIX_INTEGRATION_PREFIX,
  INSTAGRAM_INTEGRATION_PREFIX,
  MESSENGER_INTEGRATION_PREFIX,
  WHATSAPP_INTEGRATION_PREFIX,
] as const;

const CHANNEL_CONVERSATION_PREFIXES = [
  GCHAT_INTEGRATION_PREFIX,
  GITHUB_INTEGRATION_PREFIX,
  LINEAR_INTEGRATION_PREFIX,
  SLACK_INTEGRATION_PREFIX,
  TEAMS_INTEGRATION_PREFIX,
  TELEGRAM_INTEGRATION_PREFIX,
  TWILIO_INTEGRATION_PREFIX,
  DISCORD_INTEGRATION_PREFIX,
  PANCAKE_INTEGRATION_PREFIX,
  ZALO_INTEGRATION_PREFIX,
  MATRIX_INTEGRATION_PREFIX,
  INSTAGRAM_INTEGRATION_PREFIX,
  MESSENGER_INTEGRATION_PREFIX,
  WHATSAPP_INTEGRATION_PREFIX,
] as const;

export interface AccountAgentScopedKey {
  accountId: string;
  agentId: string;
  key: string;
}

export function normalizeFilesystemNamespace(conversationKey: string): string {
  return `${FILESYSTEM_NAMESPACE_PREFIX}${hashScopedValue("filesystem-namespace", conversationKey)}`;
}

/** The folder one agent owns inside an agent-isolated workspace namespace. */
export function agentNamespaceFolder(agentId: string): string {
  return `agent/${normalizeFilesystemNamespace(agentId)}`;
}

export function channelScopeKeyFromConversation(
  conversationKey: string,
  scope: "channel" | "conversation" = "channel",
): string {
  const unscopedKey = unscopedChannelConversationKey(conversationKey);
  if (scope === "conversation") {
    return unscopedKey;
  }

  // Only under the Matrix prefix: a public key may contain the separator (`customer|a`).
  if (unscopedKey.startsWith(MATRIX_INTEGRATION_PREFIX)) {
    const boundary = unscopedKey.indexOf(CHANNEL_THREAD_SEPARATOR);

    return boundary === -1 ? unscopedKey : unscopedKey.slice(0, boundary);
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
  // A Google Chat thread is `spaces/X/threads/Y` (or `/messages/Y`) in space `spaces/X`.
  if (unscopedKey.startsWith(GCHAT_INTEGRATION_PREFIX)) {
    const parts = unscopedKey.split("/");

    return parts.length >= 3 ? parts.slice(0, 2).join("/") : unscopedKey;
  }
  // A Teams channel thread is `<channel>;messageid=<root>`.
  if (unscopedKey.startsWith(TEAMS_INTEGRATION_PREFIX)) {
    const boundary = unscopedKey.indexOf(";");

    return boundary === -1 ? unscopedKey : unscopedKey.slice(0, boundary);
  }
  // A Linear thread is `linear:{issueId}:c:{rootCommentId}` on its issue.
  if (unscopedKey.startsWith(LINEAR_INTEGRATION_PREFIX)) {
    const parts = unscopedKey.split(":");

    return parts.length >= 4 ? parts.slice(0, 2).join(":") : unscopedKey;
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

export function publicEventIdForScope(
  value: string | undefined,
  accountId: string,
  agentId: string,
  fallback: string,
): string {
  if (!value) return fallback;
  const prefix = `acct:${accountId}:agent:${agentId}:${DIRECT_API_EVENT_ID_PREFIX}`;

  return value.startsWith(prefix) ? value.slice(prefix.length) : fallback;
}

export function accountAgentScopedKey(
  accountId: string,
  agentId: string,
  key: string,
): string {
  return accountScopedKey(accountId, `agent:${agentId}:${key}`);
}

export function createRunId(): string {
  return `${RUN_ID_PREFIX}${crypto.randomUUID().replaceAll("-", "")}`;
}

export function isRunId(value: string): boolean {
  return RUN_ID.test(value);
}

export function createSubagentTaskId(
  parentEventId: string,
  taskNonce: string = crypto.randomUUID(),
): string {
  const parentScope = parseAccountAgentScopedKey(parentEventId);
  if (!parentScope) {
    throw new Error("Subagent parent event must be account and agent scoped");
  }
  if (!UUID_EXACT.test(taskNonce)) {
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

export function subagentTaskNonce(taskId: string): string | null {
  return SUBAGENT_TASK_ID.exec(taskId)?.[2] ?? null;
}

export function subagentParentEventId(taskId: string): string | null {
  const match = SUBAGENT_TASK_ID.exec(taskId);
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

function hashScopedValue(scope: string, value: string): string {
  return createHash("sha256")
    .update(scope)
    .update("\0")
    .update(value)
    .digest("hex")
    .slice(0, HASH_HEX_LENGTH);
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
