import { isPlainObject } from "./objects";

export type SlackDirectoryEntry = {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
};

export type SlackDirectoryResult =
  | { ok: true; channels: SlackDirectoryEntry[]; truncated: boolean }
  | {
      ok: false;
      status: number;
      error: string;
      reason: "ratelimited" | "missing_scope" | "invalid_auth" | "slack_error";
      retryAfterSeconds?: number;
    };

type SlackDirectoryPage =
  | { data: Record<string, unknown> }
  | { failure: Extract<SlackDirectoryResult, { ok: false }> };

export const SLACK_DIRECTORY_PAGE_CAP = 10;

export const SLACK_DIRECTORY_TIMEOUT_MS = 15_000;

export const SLACK_DIRECTORY_TOTAL_BUDGET_MS = 45_000;

export async function fetchSlackChannelDirectory(
  botToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SlackDirectoryResult> {
  const channels: SlackDirectoryEntry[] = [];
  const deadline = Date.now() + SLACK_DIRECTORY_TOTAL_BUDGET_MS;
  let cursor: string | undefined;
  for (let page = 0; page < SLACK_DIRECTORY_PAGE_CAP; page++) {
    if (page > 0 && Date.now() >= deadline) break;
    const result = await fetchSlackDirectoryPage(botToken, cursor, fetchImpl);
    if ("failure" in result) {
      return result.failure;
    }
    appendSlackDirectoryEntries(channels, result.data);
    cursor = nextSlackCursor(result.data);
    if (!cursor) break;
  }
  channels.sort((a, b) => a.name.localeCompare(b.name));

  return { ok: true, channels: channels, truncated: cursor !== undefined };
}

function appendSlackDirectoryEntries(
  channels: SlackDirectoryEntry[],
  data: Record<string, unknown>,
): void {
  const pageChannels = Array.isArray(data.channels) ? data.channels : [];
  for (const entry of pageChannels) {
    if (
      !isPlainObject(entry) ||
      typeof entry.id !== "string" ||
      typeof entry.name !== "string"
    )
      continue;
    channels.push({
      id: entry.id,
      name: entry.name,
      isPrivate: entry.is_private === true,
      isMember: entry.is_member === true,
    });
  }
}

async function fetchSlackDirectoryPage(
  botToken: string,
  cursor: string | undefined,
  fetchImpl: typeof fetch,
): Promise<SlackDirectoryPage> {
  const url = new URL("https://slack.com/api/conversations.list");
  url.searchParams.set("types", "public_channel,private_channel");
  url.searchParams.set("exclude_archived", "true");
  url.searchParams.set("limit", "200");
  if (cursor) url.searchParams.set("cursor", cursor);
  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      headers: { Authorization: `Bearer ${botToken}` },
      // Guarded: AbortSignal.timeout may not exist in every runtime.
      ...(typeof AbortSignal !== "undefined" &&
      typeof AbortSignal.timeout === "function"
        ? { signal: AbortSignal.timeout(SLACK_DIRECTORY_TIMEOUT_MS) }
        : {}),
    });
  } catch {
    return {
      failure: {
        ok: false,
        status: 502,
        error: "Slack did not respond in time",
        reason: "slack_error",
      },
    };
  }
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after"));

    return {
      failure: {
        ok: false,
        status: 429,
        error: "Slack rate limit hit; retry shortly",
        reason: "ratelimited",
        ...(Number.isInteger(retryAfter) && retryAfter > 0
          ? { retryAfterSeconds: retryAfter }
          : {}),
      },
    };
  }
  let data: Record<string, unknown>;
  try {
    const parsed: unknown = await response.json();
    data = isPlainObject(parsed) ? parsed : {};
  } catch {
    data = {};
  }
  if (data.ok !== true) {
    return { failure: slackApiErrorResult(data) };
  }

  return { data: data };
}

function nextSlackCursor(data: Record<string, unknown>): string | undefined {
  const metadata = isPlainObject(data.response_metadata)
    ? data.response_metadata
    : undefined;

  return typeof metadata?.next_cursor === "string" &&
    metadata.next_cursor.length > 0
    ? metadata.next_cursor
    : undefined;
}

function slackApiErrorResult(
  data: Record<string, unknown>,
): Extract<SlackDirectoryResult, { ok: false }> {
  const error = typeof data.error === "string" ? data.error : "unknown_error";
  if (error === "missing_scope") {
    return {
      ok: false,
      status: 502,
      error:
        "The Slack app is missing a scope required to list public/private channels",
      reason: "missing_scope",
    };
  }
  if (
    error === "invalid_auth" ||
    error === "not_authed" ||
    error === "account_inactive" ||
    error === "token_revoked"
  ) {
    return {
      ok: false,
      status: 502,
      error: "Slack rejected the stored bot token",
      reason: "invalid_auth",
    };
  }

  return {
    ok: false,
    status: 502,
    error: `Slack error: ${error}`,
    reason: "slack_error",
  };
}
