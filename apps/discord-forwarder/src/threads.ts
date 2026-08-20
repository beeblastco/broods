/**
 * Resolves the `thread` object Discord's `MESSAGE_CREATE` leaves out.
 *
 * Inside a thread, Discord sets `channel_id` to the thread and says nothing
 * about the channel it hangs under. Core needs both — `toDiscordGatewayThread`
 * keys a threaded conversation as `discord:{guild}:{parent}:{thread}` and gates
 * the allow list on the parent, which is also how the slash-command path
 * resolves — so a forwarded event without it disagrees with `/new` typed in the
 * same thread and trips channel allow lists that name the parent.
 *
 * This is restating a fact Discord omitted, not choosing where a reply lands.
 * Opening a *new* thread on a mention is a product decision and stays out of
 * here; see the `replyIn` follow-up on issue #320.
 */

import {
  DISCORD_API_URL,
  THREAD_CHANNEL_TYPES,
  type DiscordChannel,
  type ForwardedThread,
} from "./discord.ts";
import { logWarn, tokenHint } from "./log.ts";

export class ThreadDirectory {
  private readonly botToken: string;
  private readonly hint: string;
  // Channel types never change, so one resolved answer holds for the life of
  // the process. Failed lookups are not cached, so a rate limit self-heals.
  private readonly cache = new Map<string, ForwardedThread | null>();

  constructor(botToken: string) {
    this.botToken = botToken;
    this.hint = tokenHint(botToken);
  }

  /** The thread `channelId` is, or null when it is an ordinary channel. */
  async resolve(channelId: string): Promise<ForwardedThread | null> {
    const cached = this.cache.get(channelId);
    if (cached !== undefined) return cached;

    const channel = await this.fetchChannel(channelId);
    if (!channel) return null;

    const thread =
      THREAD_CHANNEL_TYPES.has(channel.type) && channel.parent_id
        ? { id: channel.id, parent_id: channel.parent_id }
        : null;
    this.cache.set(channelId, thread);

    return thread;
  }

  // Answers null on any failure rather than throwing: this runs inside a socket
  // event handler, where an escaping rejection would take the process down and
  // turn one bad lookup into a restart that spends IDENTIFY budget.
  private async fetchChannel(
    channelId: string,
  ): Promise<DiscordChannel | null> {
    let detail: string;
    try {
      const response = await fetch(`${DISCORD_API_URL}/channels/${channelId}`, {
        headers: { Authorization: `Bot ${this.botToken}` },
      });
      if (response.ok) return (await response.json()) as DiscordChannel;
      detail = `HTTP ${response.status}`;
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }
    logWarn("Discord channel lookup failed", {
      channelId: channelId,
      detail: detail,
      tokenHint: this.hint,
    });

    return null;
  }
}
