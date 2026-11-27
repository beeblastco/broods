export const DISCORD_API_URL = "https://discord.com/api/v10";
export const DISCORD_GATEWAY_URL = "wss://gateway.discord.gg";

// Retrying these spends IDENTIFY budget on a dial that cannot succeed until the config changes.
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

// Bun's fetch has no deadline: a peer that never answers would lose the message unlogged.
export const FETCH_TIMEOUT_MS = 10_000;

export const HEARTBEAT_MAX_MS = 300_000;
export const HEARTBEAT_MIN_MS = 1_000;

// These end the session, not just the socket: the next dial must IDENTIFY, not RESUME.
export const SESSION_ENDING_CLOSE_CODES: ReadonlySet<number> = new Set([
  4007, 4009,
]);

export const THREAD_CHANNEL_TYPES: ReadonlySet<number> = new Set([10, 11, 12]);

const GATEWAY_HOST_LABEL = /^[a-z0-9][a-z0-9-]{0,62}$/;
const GATEWAY_HOST_SUFFIX = ".discord.gg";

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

export interface ForwardedThread {
  id: string;
  parent_id: string;
}

export interface GatewayHello {
  heartbeat_interval?: unknown;
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

/** Forwarded verbatim and parsed by core, so only the routing fields are named. */
export interface MessageCreate {
  channel_id: string;
  guild_id?: string | null;
  id: string;
  [key: string]: unknown;
}

/** Clamped: an unbounded HELLO interval is a hot loop or a socket that never beats. */
export function heartbeatIntervalMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return HEARTBEAT_MAX_MS;
  }
  if (value > HEARTBEAT_MAX_MS) return HEARTBEAT_MAX_MS;
  if (value < HEARTBEAT_MIN_MS) return HEARTBEAT_MIN_MS;

  return value;
}

/**
 * RESUME carries the bot token, so only one DNS label of READY's host survives, rebuilt onto a
 * literal Discord suffix. Another domain, a path, a port or a non-wss scheme answers null.
 */
export function resumeGatewayUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "wss:" || url.port || url.pathname !== "/") return null;
  if (!url.hostname.endsWith(GATEWAY_HOST_SUFFIX)) return null;

  const label = url.hostname.slice(
    0,
    url.hostname.length - GATEWAY_HOST_SUFFIX.length,
  );
  if (!GATEWAY_HOST_LABEL.test(label)) return null;

  return `wss://${label}${GATEWAY_HOST_SUFFIX}`;
}
