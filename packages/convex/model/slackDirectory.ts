/**
 * Slack channel-directory fetcher backing the config plane's
 * GET /v1/agents/{id}/channels/slack/directory route. Kept free of Convex
 * imports so the pagination and error mapping are unit-testable.
 */

import { isPlainObject } from "./objects";

/** One channel row in the directory response: Slack channel id/name plus privacy and bot-membership flags. */
export type SlackDirectoryEntry = {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
};

/** Directory outcome: the sorted channel list, or an HTTP status + reason for the route to relay. */
export type SlackDirectoryResult =
  | { ok: true; channels: SlackDirectoryEntry[]; truncated: boolean }
  | {
      ok: false;
      status: number;
      error: string;
      reason: "ratelimited" | "missing_scope" | "invalid_auth" | "slack_error";
    };

/** Defensive page cap so a huge workspace can't spin the action forever. */
export const SLACK_DIRECTORY_PAGE_CAP = 10;

/** Upper bound for each Slack API call so a stalled request can't hang the action. */
export const SLACK_DIRECTORY_TIMEOUT_MS = 15_000;

/** End-to-end pagination budget so slow-but-responsive pages fail fast as a truncated result instead of hitting upstream action timeouts. */
export const SLACK_DIRECTORY_TOTAL_BUDGET_MS = 45_000;

/**
 * Paginate Slack conversations.list (Tier 2, ~20 req/min) into a directory
 * result. `truncated` is true when the page cap or time budget was hit while
 * Slack still reported another cursor; malformed entries are skipped rather
 * than returned.
 */
export async function fetchSlackChannelDirectory(
  botToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SlackDirectoryResult> {
  const channels: SlackDirectoryEntry[] = [];
  const deadline = Date.now() + SLACK_DIRECTORY_TOTAL_BUDGET_MS;
  let cursor: string | undefined;
  for (let page = 0; page < SLACK_DIRECTORY_PAGE_CAP; page++) {
    // Later pages only run while the overall budget holds; what's already
    // collected is returned as a truncated result below.
    if (page > 0 && Date.now() >= deadline) break;
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
        ok: false,
        status: 502,
        error: "Slack did not respond in time",
        reason: "slack_error",
      };
    }
    if (response.status === 429) {
      return {
        ok: false,
        status: 429,
        error: "Slack rate limit hit; retry shortly",
        reason: "ratelimited",
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
      const error =
        typeof data.error === "string" ? data.error : "unknown_error";
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
    const metadata = isPlainObject(data.response_metadata)
      ? data.response_metadata
      : undefined;
    cursor =
      typeof metadata?.next_cursor === "string" &&
      metadata.next_cursor.length > 0
        ? metadata.next_cursor
        : undefined;
    if (!cursor) break;
  }
  channels.sort((a, b) => a.name.localeCompare(b.name));

  return { ok: true, channels: channels, truncated: cursor !== undefined };
}
