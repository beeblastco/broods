/**
 * Keeps each Gmail channel's watch alive. A watch makes Gmail publish inbox
 * changes to the channel's Pub/Sub topic and lapses after seven days, so the
 * projection writer (`model/channelEndpoints.ts`) starts one when a mailbox is
 * deployed or changed, and the daily cron in `crons.ts` renews them all.
 * Core's `gmail-channel.ts` receives what the watch publishes.
 */

import { v, type Infer } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { internalAction, internalQuery } from "../_generated/server";
import { accountCipher, encryptionSecrets } from "../model/accountKeys";
import { channelEndpointSecrets } from "../model/channelEndpoints";
import type { AccountCipher } from "../model/envelope";

const GMAIL_API_URL = "https://gmail.googleapis.com/gmail/v1/users";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const REQUEST_TIMEOUT_MS = 15_000;
// Renewals run this many mailboxes at a time, well under the action's limit.
const RENEW_BATCH_SIZE = 25;
// A watch that fails to start on a passing Google error is retried on this
// schedule before the daily renewal picks it up.
const START_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];

const watchTargetValidator = v.object({
  clientId: v.string(),
  clientSecret: v.string(),
  mailbox: v.string(),
  refreshToken: v.string(),
  topicName: v.string(),
});

type WatchTarget = Infer<typeof watchTargetValidator>;

/**
 * Renews every Gmail watch, once per distinct setup: stages and agents that
 * share a mailbox and topic share its one watch. A mailbox holds one watch,
 * so rows that name two topics for it are skipped and logged rather than
 * left to race.
 */
export const renewAll = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    const all = await ctx.runQuery(internal.channel.gmail.targets, {});
    const renewable = watchableTargets(all);
    for (let i = 0; i < renewable.length; i += RENEW_BATCH_SIZE) {
      await Promise.all(
        renewable.slice(i, i + RENEW_BATCH_SIZE).map(watchMailbox),
      );
    }

    return null;
  },
});

/** One projection row's watch target, or null once the row is gone. */
export const target = internalQuery({
  args: { rowId: v.id("channelEndpoints") },
  returns: v.union(watchTargetValidator, v.null()),
  handler: async (ctx, args): Promise<WatchTarget | null> => {
    const row = await ctx.db.get(args.rowId);
    if (!row) return null;

    return await rowWatchTarget(row, await accountCipher(ctx, row.accountId));
  },
});

/** Every deployed Gmail channel's watch target. */
export const targets = internalQuery({
  args: {},
  returns: v.array(watchTargetValidator),
  handler: async (ctx): Promise<WatchTarget[]> => {
    encryptionSecrets();
    const rows = await ctx.db
      .query("channelEndpoints")
      .withIndex("by_platform", (q) => q.eq("platform", "gmail"))
      .collect();
    const found: WatchTarget[] = [];
    for (const row of rows) {
      const target = await rowWatchTarget(
        row,
        await accountCipher(ctx, row.accountId),
      );
      if (target) found.push(target);
    }

    return found;
  },
});

/**
 * Starts the watch for one projection row. A passing failure is retried on
 * `START_RETRY_DELAYS_MS`; a refused grant waits for the operator.
 */
export const watch = internalAction({
  args: {
    rowId: v.id("channelEndpoints"),
    attempt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const found = await ctx.runQuery(internal.channel.gmail.target, {
      rowId: args.rowId,
    });
    if (!found) return null;
    const attempt = args.attempt ?? 0;
    const delay = START_RETRY_DELAYS_MS[attempt];
    const outcome = await watchMailbox(found);
    if (outcome === "retry" && delay !== undefined) {
      await ctx.scheduler.runAfter(delay, internal.channel.gmail.watch, {
        rowId: args.rowId,
        attempt: attempt + 1,
      });
    }

    return null;
  },
});

// A non-2xx answer from Google: the body names the reason and never echoes
// a secret. Google's own trouble (5xx) and throttling (429) pass; the rest
// is the grant or the request, which no retry fixes.
class GoogleRequestError extends Error {
  readonly transient: boolean;

  constructor(status: number, body: string) {
    super(`${status} ${body}`);
    this.transient = status >= 500 || status === 429;
  }
}

// POSTs to Google and answers the parsed JSON body.
async function googlePost(
  url: string,
  init: { body: string | URLSearchParams; headers?: Record<string, string> },
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    body: init.body,
    headers: init.headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new GoogleRequestError(response.status, await response.text());
  }

  return await response.json();
}

// A Gmail row's watch target, or null when its projected secrets are incomplete.
async function rowWatchTarget(
  row: Doc<"channelEndpoints">,
  cipher: AccountCipher,
): Promise<WatchTarget | null> {
  const { clientId, clientSecret, mailbox, refreshToken, topicName } =
    await channelEndpointSecrets(row, cipher);
  if (!clientId || !clientSecret || !mailbox || !refreshToken || !topicName) {
    return null;
  }

  return {
    clientId: clientId,
    clientSecret: clientSecret,
    mailbox: mailbox,
    refreshToken: refreshToken,
    topicName: topicName,
  };
}

// The targets a renewal can act on: one per distinct setup, minus every
// mailbox whose rows disagree on the topic.
function watchableTargets(all: WatchTarget[]): WatchTarget[] {
  const distinct = new Map(
    all.map((target) => [JSON.stringify(target), target] as const),
  );
  const byMailbox = new Map<string, WatchTarget[]>();
  for (const target of distinct.values()) {
    const key = `${target.mailbox}\n${target.clientId}`;
    byMailbox.set(key, [...(byMailbox.get(key) ?? []), target]);
  }
  const renewable: WatchTarget[] = [];
  for (const targets of byMailbox.values()) {
    const topics = new Set(targets.map((target) => target.topicName));
    if (topics.size === 1) {
      renewable.push(...targets);
      continue;
    }
    console.error("Gmail mailbox names more than one watch topic", {
      mailbox: targets[0].mailbox,
      topics: [...topics],
    });
  }

  return renewable;
}

// One mailbox's watch on its inbox: a refresh-token grant, then `watch`. A
// failure is logged, so one revoked grant never stops the others; the answer
// says whether a retry could help.
async function watchMailbox(
  target: WatchTarget,
): Promise<"ok" | "retry" | "failed"> {
  try {
    const { access_token: accessToken } = await googlePost(GOOGLE_TOKEN_URL, {
      body: new URLSearchParams({
        client_id: target.clientId,
        client_secret: target.clientSecret,
        grant_type: "refresh_token",
        refresh_token: target.refreshToken,
      }),
    });
    if (typeof accessToken !== "string" || !accessToken) {
      throw new Error("token response carried no access_token");
    }
    await googlePost(
      `${GMAIL_API_URL}/${encodeURIComponent(target.mailbox)}/watch`,
      {
        body: JSON.stringify({
          labelIds: ["INBOX"],
          topicName: target.topicName,
        }),
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      },
    );
  } catch (error) {
    console.error("Gmail watch failed", {
      mailbox: target.mailbox,
      error: error instanceof Error ? error.message : String(error),
    });

    return error instanceof GoogleRequestError && !error.transient
      ? "failed"
      : "retry";
  }

  return "ok";
}
