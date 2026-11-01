import {
  DISCORD_API_URL,
  FETCH_TIMEOUT_MS,
  THREAD_CHANNEL_TYPES,
  type DiscordChannel,
  type ForwardedThread,
} from "./discord.ts";

const MAX_CACHED_CHANNELS = 10_000;

/**
 * In a thread MESSAGE_CREATE's `channel_id` is the thread and the parent goes unsaid, yet core
 * keys the conversation and gates allow lists on the parent, as the slash-command path does.
 */
export class ThreadDirectory {
  private readonly botToken: string;
  // Channel types never change, so an answer holds for the life of the process.
  private readonly cache = new Map<string, ForwardedThread | null>();
  private readonly inFlight = new Map<
    string,
    Promise<ForwardedThread | null>
  >();

  constructor(botToken: string) {
    this.botToken = botToken;
  }

  /** Rejects when Discord will not say, so the message drops rather than lose its thread. */
  async resolve(channelId: string): Promise<ForwardedThread | null> {
    const cached = this.cache.get(channelId);
    if (cached !== undefined) return cached;
    const pending = this.inFlight.get(channelId);
    if (pending) return pending;

    const lookup = this.lookup(channelId).finally((): void => {
      this.inFlight.delete(channelId);
    });
    this.inFlight.set(channelId, lookup);

    return lookup;
  }

  private async fetchChannel(
    channelId: string,
    retried = false,
  ): Promise<DiscordChannel> {
    const response = await fetch(`${DISCORD_API_URL}/channels/${channelId}`, {
      headers: { Authorization: `Bot ${this.botToken}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.ok) return (await response.json()) as DiscordChannel;
    if (response.status === 429 && !retried) {
      // Capped so one lookup cannot hold a message for a whole global rate limit.
      const retryAfterSeconds =
        Number(response.headers.get("retry-after")) || 1;
      await Bun.sleep(Math.min(FETCH_TIMEOUT_MS, retryAfterSeconds * 1_000));

      return this.fetchChannel(channelId, true);
    }

    throw new Error(
      `Discord channel ${channelId} lookup failed: HTTP ${response.status}`,
    );
  }

  private async lookup(channelId: string): Promise<ForwardedThread | null> {
    const channel = await this.fetchChannel(channelId);
    const thread =
      THREAD_CHANNEL_TYPES.has(channel.type) && channel.parent_id
        ? { id: channel.id, parent_id: channel.parent_id }
        : null;
    if (this.cache.size >= MAX_CACHED_CHANNELS) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(channelId, thread);

    return thread;
  }
}
