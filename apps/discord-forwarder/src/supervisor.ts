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
   * A fatal socket is replaced only when its own targets change, the one sign the owner fixed
   * the bot. Any other reconcile, or a timer, would spend an IDENTIFY on a bot still refused.
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
        const moved =
          JSON.stringify(existing.targets) !== JSON.stringify(targets);
        if (!moved || existing.socket.state !== "fatal") {
          if (webhookUrls(existing.targets).join(" ") !== urls.join(" ")) {
            warnOnSharedToken("Discord", botToken, urls);
          }
          existing.targets = targets;
          continue;
        }
        existing.socket.stop();
      }
      warnOnSharedToken("Discord", botToken, urls);
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
    if (!this.managed.has(botToken)) return;

    const thread = data.guild_id
      ? await threads.resolve(data.channel_id)
      : null;
    // Read after the await: `reconcile` may have replaced the targets while Discord answered.
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
        void this.deliver(botToken, threads, data).catch(
          (error: unknown): void => {
            logError("Discord message could not be delivered", {
              channelId: data.channel_id,
              error: error instanceof Error ? error.message : String(error),
              messageId: data.id,
              tokenHint: tokenHint(botToken),
            });
          },
        );
      },
    });
    // Before start(), so the first event always finds its targets.
    this.managed.set(botToken, { socket: socket, targets: targets });
    logInfo("Discord connection added", {
      targets: targets.length,
      tokenHint: tokenHint(botToken),
    });
    socket.start();
  }
}

/** One socket per token, even across planes: with two, Discord delivers every event twice. */
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

export function warnOnSharedToken(
  channel: string,
  botToken: string,
  webhooks: readonly string[],
): void {
  if (webhooks.length < 2) return;

  logWarn(`One ${channel} token serves several webhooks, every one will run`, {
    targets: webhooks.length,
    tokenHint: tokenHint(botToken),
  });
}

export function webhookUrls(targets: readonly ForwardTarget[]): string[] {
  return [
    ...new Set(targets.map((target): string => target.webhookUrl)),
  ].sort();
}
