/**
 * Holds the live set of Gateway sockets and keeps it equal to what the config
 * plane says it should be.
 *
 * Sockets are keyed by bot token, not by agent, because the token is what
 * Discord counts connections against. That also makes token rotation fall out
 * for free: a rotated token reads as one key disappearing and another arriving,
 * which is exactly the reconnect it needs.
 */

import type { ForwarderConfig } from "./config.ts";
import type { DiscordConnection } from "./connections.ts";
import type { MessageCreate } from "./discord.ts";
import { forwardMessageCreate, type ForwardTarget } from "./forward.ts";
import { IdentifyBudget } from "./identify-budget.ts";
import { logInfo, logWarn, tokenHint } from "./log.ts";
import {
  GatewaySocket,
  type GatewaySocketOptions,
  type SocketState,
} from "./socket.ts";
import { ThreadDirectory } from "./threads.ts";

/** The slice of `GatewaySocket` the supervisor drives, so tests can stub it. */
export interface ForwarderSocket {
  readonly botIdentity: string | null;
  readonly state: SocketState;
  start(): void;
  stop(): void;
}

export type SocketFactory = (options: GatewaySocketOptions) => ForwarderSocket;

export interface ForwarderStatus {
  sockets: Array<{
    botUserId: string | null;
    state: SocketState;
    targets: number;
    tokenHint: string;
  }>;
  targets: number;
}

export class Forwarder {
  private readonly budget: IdentifyBudget;
  private readonly config: ForwarderConfig;
  private readonly createSocket: SocketFactory;
  private readonly managed = new Map<
    string,
    { socket: ForwarderSocket; targets: ForwardTarget[] }
  >();

  constructor(
    config: ForwarderConfig,
    createSocket: SocketFactory = (options) => new GatewaySocket(options),
  ) {
    this.budget = new IdentifyBudget(
      config.identifyLimit,
      config.identifyWindowMs,
    );
    this.config = config;
    this.createSocket = createSocket;
  }

  /**
   * Opens sockets for tokens that gained a connection, closes the ones that lost
   * every connection, and re-points the rest. An unchanged token keeps its
   * socket: its session, sequence number and IDENTIFY history all survive.
   */
  reconcile(connections: readonly DiscordConnection[]): void {
    const desired = groupConnectionsByToken(
      connections,
      this.config.webhookBaseUrl,
    );

    for (const [botToken, entry] of this.managed) {
      if (desired.has(botToken)) continue;
      entry.socket.stop();
      this.managed.delete(botToken);
      logInfo("Discord connection removed", {
        tokenHint: tokenHint(botToken),
      });
    }

    for (const [botToken, targets] of desired) {
      const existing = this.managed.get(botToken);
      if (existing) {
        // Only on a change: reconcile runs on a timer, and an unconditional warn
        // would repeat this line for the life of the process.
        if (existing.targets.length !== targets.length) {
          warnOnSharedToken(botToken, targets);
        }
        existing.targets = targets;
        continue;
      }
      warnOnSharedToken(botToken, targets);
      this.managed.set(botToken, {
        socket: this.open(botToken, targets),
        targets: targets,
      });
    }
  }

  status(): ForwarderStatus {
    let targets = 0;
    const sockets = [...this.managed].map(([botToken, entry]) => {
      targets += entry.targets.length;

      return {
        botUserId: entry.socket.botIdentity,
        state: entry.socket.state,
        targets: entry.targets.length,
        tokenHint: tokenHint(botToken),
      };
    });

    return {
      sockets: sockets,
      targets: targets,
    };
  }

  stop(): void {
    for (const entry of this.managed.values()) entry.socket.stop();
    this.managed.clear();
  }

  private open(botToken: string, targets: ForwardTarget[]): ForwarderSocket {
    const hint = tokenHint(botToken);
    const threads = new ThreadDirectory(botToken, hint);
    const socket = this.createSocket({
      botToken: botToken,
      budget: this.budget,
      config: this.config,
      onMessageCreate: (data: MessageCreate): void => {
        // Read the targets through the map so a reconcile between events is
        // picked up without reopening the socket.
        const current = this.managed.get(botToken)?.targets ?? targets;
        void deliver(data, threads, botToken, current, hint);
      },
      tokenHint: hint,
    });
    logInfo("Discord connection added", {
      targets: targets.length,
      tokenHint: hint,
    });
    socket.start();

    return socket;
  }
}

/**
 * One socket per bot token, fanned out to every webhook that token serves.
 * Two agents sharing a token is unusual but legal, and it must not become two
 * sockets — Discord would then deliver every event twice.
 */
export function groupConnectionsByToken(
  connections: readonly DiscordConnection[],
  webhookBaseUrl: string,
): Map<string, ForwardTarget[]> {
  const grouped = new Map<string, ForwardTarget[]>();
  for (const connection of connections) {
    const targets = grouped.get(connection.botToken) ?? [];
    targets.push({
      accountId: connection.accountId,
      agentId: connection.agentId,
      agentName: connection.agentName,
      webhookUrl: `${webhookBaseUrl}${connection.webhookPath}`,
    });
    grouped.set(connection.botToken, targets);
  }

  return grouped;
}

async function deliver(
  data: MessageCreate,
  threads: ThreadDirectory,
  botToken: string,
  targets: readonly ForwardTarget[],
  hint: string,
): Promise<void> {
  const thread = await threads.resolve(data.channel_id);
  await forwardMessageCreate(data, thread, botToken, targets, hint);
}

function warnOnSharedToken(
  botToken: string,
  targets: readonly ForwardTarget[],
): void {
  const paths = new Set(targets.map((target) => target.webhookUrl));
  if (paths.size < 2) return;

  logWarn("One Discord bot token serves several webhooks, every one will run", {
    targets: paths.size,
    tokenHint: tokenHint(botToken),
  });
}
