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
import type { ForwarderConnection } from "./connections.ts";
import type { MessageCreate } from "./discord.ts";
import { forwardMessageCreate, type ForwardTarget } from "./forward.ts";
import { IdentifyBudget } from "./identify-budget.ts";
import { logError, logInfo, logWarn, tokenHint } from "./log.ts";
import {
  GatewaySocket,
  type GatewaySocketOptions,
  type SocketState,
} from "./socket.ts";
import { ThreadDirectory } from "./threads.ts";

export type SocketFactory = (options: GatewaySocketOptions) => ForwarderSocket;

/** The slice of `GatewaySocket` the supervisor drives, so tests can stub it. */
export interface ForwarderSocket {
  readonly botIdentity: string | null;
  readonly state: SocketState;
  start(): void;
  stop(): void;
}

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
    createSocket: SocketFactory = (options): ForwarderSocket =>
      new GatewaySocket(options),
  ) {
    this.budget = new IdentifyBudget(config.identifyLimit);
    this.config = config;
    this.createSocket = createSocket;
  }

  /**
   * Opens sockets for tokens that gained a connection, closes the ones that lost
   * every connection, and re-points the rest. An unchanged token keeps its
   * socket: its session, sequence number and IDENTIFY history all survive.
   */
  reconcile(connections: readonly ForwarderConnection[]): void {
    const desired = groupConnectionsByToken(connections);

    for (const [botToken, entry] of this.managed) {
      if (desired.has(botToken)) continue;
      entry.socket.stop();
      this.managed.delete(botToken);
      logInfo("Discord connection removed", {
        tokenHint: tokenHint(botToken),
      });
    }

    for (const [botToken, targets] of desired) {
      const urls = webhookUrls(targets);
      const existing = this.managed.get(botToken);
      if (existing) {
        // reconcile runs on every config change, so warn only when the fan-out
        // itself moved.
        if (webhookUrls(existing.targets).join(" ") !== urls.join(" ")) {
          warnOnSharedToken(botToken, urls);
        }
        existing.targets = targets;
        continue;
      }
      warnOnSharedToken(botToken, urls);
      this.open(botToken, targets);
    }
  }

  status(): ForwarderStatus {
    const sockets = [...this.managed].map(
      ([botToken, entry]): ForwarderStatus["sockets"][number] => ({
        botUserId: entry.socket.botIdentity,
        state: entry.socket.state,
        targets: entry.targets.length,
        tokenHint: tokenHint(botToken),
      }),
    );

    return {
      sockets: sockets,
      targets: sockets.reduce(
        (total, socket): number => total + socket.targets,
        0,
      ),
    };
  }

  stop(): void {
    for (const entry of this.managed.values()) entry.socket.stop();
    this.managed.clear();
  }

  private async deliver(
    botToken: string,
    threads: ThreadDirectory,
    data: MessageCreate,
  ): Promise<void> {
    // Nothing to deliver to once the token is gone, and no reason to ask Discord
    // about the channel either.
    if (!this.managed.has(botToken)) return;

    const thread = await threads.resolve(data.channel_id);
    // Read after the lookup, not before. `resolve` can wait on Discord, and
    // `reconcile` replaces the array outright, so a set read on the way in is
    // already stale by here — which is the whole reason this goes through the map
    // instead of closing over the array.
    const targets = this.managed.get(botToken)?.targets;
    if (!targets?.length) return;

    await forwardMessageCreate(data, thread, botToken, targets);
  }

  private open(botToken: string, targets: ForwardTarget[]): void {
    const threads = new ThreadDirectory(botToken);
    const socket = this.createSocket({
      botToken: botToken,
      budget: this.budget,
      config: this.config,
      onMessageCreate: (data: MessageCreate): void => {
        // Nothing below is meant to reject, but an unhandled rejection here
        // takes the process down, and a restart is another IDENTIFY.
        void this.deliver(botToken, threads, data).catch(
          (error: unknown): void => {
            logError("Discord message could not be delivered", {
              error: error instanceof Error ? error.message : String(error),
              tokenHint: tokenHint(botToken),
            });
          },
        );
      },
    });
    // Registered before the socket starts, so the first event to arrive always
    // finds its targets.
    this.managed.set(botToken, { socket: socket, targets: targets });
    logInfo("Discord connection added", {
      targets: targets.length,
      tokenHint: tokenHint(botToken),
    });
    socket.start();
  }
}

/**
 * One socket per bot token, fanned out to every webhook that token serves.
 * Two agents sharing a token is unusual but legal, and it must not become two
 * sockets — Discord would then deliver every event twice. The connections may
 * come from different config planes, so the same token deployed to both is one
 * socket here rather than one per plane.
 */
export function groupConnectionsByToken(
  connections: readonly ForwarderConnection[],
): Map<string, ForwardTarget[]> {
  const grouped = new Map<string, ForwardTarget[]>();
  for (const connection of connections) {
    const targets = grouped.get(connection.botToken) ?? [];
    targets.push({
      agentId: connection.agentId,
      agentName: connection.agentName,
      webhookUrl: connection.webhookUrl,
    });
    grouped.set(connection.botToken, targets);
  }

  return grouped;
}

function warnOnSharedToken(
  botToken: string,
  webhooks: readonly string[],
): void {
  if (webhooks.length < 2) return;

  logWarn("One Discord bot token serves several webhooks, every one will run", {
    targets: webhooks.length,
    tokenHint: tokenHint(botToken),
  });
}

/** The distinct webhooks a token fans out to, in a stable order. */
function webhookUrls(targets: readonly ForwardTarget[]): string[] {
  return [
    ...new Set(targets.map((target): string => target.webhookUrl)),
  ].sort();
}
