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
 * share a mailbox and topic share its one watch.
 */
export const renewAll = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    const all = await ctx.runQuery(internal.channel.gmail.targets, {});
    const distinct = new Map(
      all.map((target) => [JSON.stringify(target), target] as const),
    );
    await Promise.all([...distinct.values()].map(watchMailbox));

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

/** Starts or renews the watch for one projection row. */
export const watch = internalAction({
  args: { rowId: v.id("channelEndpoints") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const found = await ctx.runQuery(internal.channel.gmail.target, args);
    if (found) await watchMailbox(found);

    return null;
  },
});

// POSTs to Google and answers the parsed JSON body; a non-2xx status throws
// with Google's error body, which names the reason and never echoes a secret.
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
    throw new Error(`${response.status} ${await response.text()}`);
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

// One mailbox's watch on its inbox: a refresh-token grant, then `watch`. A
// failure is logged and left to the next renewal, so one revoked grant never
// stops the others.
async function watchMailbox(target: WatchTarget): Promise<void> {
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
  }
}
