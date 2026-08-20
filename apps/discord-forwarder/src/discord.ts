/**
 * The slice of Discord's Gateway and REST contracts this process touches.
 *
 * Deliberately narrow. Everything the agent reads out of a message is parsed by
 * `apps/core/src/shared/discord-channel.ts`, so `MessageCreate` carries only the
 * fields the forwarder itself has to look at and passes the rest through
 * untouched.
 */

export const DISCORD_API_URL = "https://discord.com/api/v10";
export const DISCORD_GATEWAY_URL = "wss://gateway.discord.gg";

// A message in one of these lives in a thread; `channel_id` is the thread and
// `parent_id` is the channel it hangs under.
export const THREAD_CHANNEL_TYPES: ReadonlySet<number> = new Set([10, 11, 12]);

/**
 * Close codes Discord will keep rejecting no matter how often we dial. Retrying
 * any of them spends IDENTIFY budget on a request that cannot start succeeding
 * without a config change.
 *
 * https://discord.com/developers/docs/topics/opcodes-and-status-codes
 */
export const FATAL_CLOSE_CODES: ReadonlyMap<number, string> = new Map([
  [4004, "Authentication failed: the bot token is not valid."],
  [4010, "Invalid shard sent in IDENTIFY."],
  [4011, "Sharding required: this bot is in too many guilds for one socket."],
  [4012, "Invalid API version."],
  [4013, "Invalid intents in IDENTIFY."],
  [
    4014,
    "Disallowed intents: enable Message Content Intent under Bot > Privileged Gateway Intents in the Discord developer portal, or the bot cannot read messages.",
  ],
]);

// Codes that end the session rather than the socket: reconnecting must IDENTIFY
// afresh instead of RESUMEing a sequence Discord has already dropped.
export const SESSION_ENDING_CLOSE_CODES: ReadonlySet<number> = new Set([
  4007, 4009,
]);

export enum GatewayOpcode {
  Dispatch = 0,
  Heartbeat = 1,
  Identify = 2,
  Resume = 6,
  Reconnect = 7,
  InvalidSession = 9,
  Hello = 10,
  HeartbeatAck = 11,
}

export interface DiscordChannel {
  id: string;
  parent_id?: string | null;
  type: number;
}

export interface GatewayHello {
  heartbeat_interval: number;
}

export interface GatewayPayload {
  d?: unknown;
  op: number;
  s?: number | null;
  t?: string | null;
}

export interface GatewayReady {
  resume_gateway_url: string;
  session_id: string;
  user: { id: string; username: string };
}

/**
 * Only the routing fields are named. The payload is forwarded verbatim and
 * parsed by core, so the index signature is the honest type for the rest: this
 * process must not develop opinions about fields it only passes through.
 */
export interface MessageCreate {
  channel_id: string;
  guild_id?: string | null;
  id: string;
  [key: string]: unknown;
}

/** The `thread` object core keys a threaded conversation off. */
export interface ForwardedThread {
  id: string;
  parent_id: string;
}
