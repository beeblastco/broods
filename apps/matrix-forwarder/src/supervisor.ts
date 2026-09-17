/**
 * Holds the live set of Matrix accounts and keeps it equal to what the config
 * planes say it should be.
 *
 * Accounts are keyed by access token, not by agent. Two sync loops on one token
 * deliver every message twice and fight over one crypto store, so a token that
 * serves several targets (the same account deployed to dev and prod) is one
 * account fanning out to each of them.
 */

import type {
  MatrixForwardedEvent,
  MatrixSendRequest,
  MatrixTypingRequest,
} from "../../core/src/shared/matrix-wire.ts";
import {
  logInfo,
  logWarn,
  tokenHint,
} from "../../discord-forwarder/src/log.ts";
import {
  warnOnSharedToken,
  webhookUrls,
} from "../../discord-forwarder/src/supervisor.ts";
import type { AccountState, MatrixAccountOptions } from "./account.ts";
import type { MatrixConnection } from "./connections.ts";
import { forwardRoomEvent, type ForwardTarget } from "./forward.ts";

/** Injected so tests never load the native crypto module; `main.ts` passes `MatrixAccount`. */
type AccountFactory = (options: MatrixAccountOptions) => ForwarderAccount;

/** An access token's desired account: its homeserver and every webhook it serves. */
interface AccountGroup {
  apiUrl: string;
  targets: ForwardTarget[];
}

/** The slice of `MatrixAccount` the supervisor and HTTP server drive. */
export interface ForwarderAccount {
  readonly state: AccountState;
  readonly userId: string | null;
  send(request: MatrixSendRequest): Promise<string>;
  setTyping(request: MatrixTypingRequest): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

export interface ForwarderStatus {
  accounts: Array<{
    state: AccountState;
    targets: number;
    tokenHint: string;
    userId: string | null;
  }>;
  targets: number;
}

interface ManagedAccount extends AccountGroup {
  account: ForwarderAccount;
}

export class Forwarder {
  private readonly createAccount: AccountFactory;
  /** Accounts removed by a reconcile, still closing their crypto store. */
  private readonly detached = new Set<Promise<void>>();
  private readonly managed = new Map<string, ManagedAccount>();
  private readonly storeDir: string;

  constructor(storeDir: string, createAccount: AccountFactory) {
    this.createAccount = createAccount;
    this.storeDir = storeDir;
  }

  /** The running account for an access token, which is how core's sends authenticate. */
  account(accessToken: string): ForwarderAccount | undefined {
    return this.managed.get(accessToken)?.account;
  }

  /**
   * Starts accounts for tokens that gained a connection, stops the ones that lost
   * every connection or moved homeserver, and re-points the rest. An unchanged
   * token keeps its account, so its sync position and open store survive.
   */
  reconcile(connections: readonly MatrixConnection[]): void {
    const desired = groupConnectionsByToken(connections);

    for (const [accessToken, entry] of this.managed) {
      const next = desired.get(accessToken);
      if (next?.apiUrl === entry.apiUrl) continue;
      this.managed.delete(accessToken);
      this.detach(entry.account);
      logInfo(
        next ? "Matrix account moved homeserver" : "Matrix account removed",
        { tokenHint: tokenHint(accessToken) },
      );
    }

    for (const [accessToken, group] of desired) {
      const urls = webhookUrls(group.targets);
      const existing = this.managed.get(accessToken);
      if (existing) {
        // reconcile runs on every config change, so warn only when the fan-out
        // itself moved.
        if (webhookUrls(existing.targets).join(" ") !== urls.join(" ")) {
          warnOnSharedToken("Matrix", accessToken, urls);
        }
        existing.targets = group.targets;
        continue;
      }
      warnOnSharedToken("Matrix", accessToken, urls);
      this.open(accessToken, group);
    }
  }

  status(): ForwarderStatus {
    const accounts = [...this.managed].map(
      ([accessToken, entry]): ForwarderStatus["accounts"][number] => ({
        state: entry.account.state,
        targets: entry.targets.length,
        tokenHint: tokenHint(accessToken),
        userId: entry.account.userId,
      }),
    );

    return {
      accounts: accounts,
      targets: accounts.reduce(
        (total, account): number => total + account.targets,
        0,
      ),
    };
  }

  async stop(): Promise<void> {
    const stopping = [...this.managed.values()].map((entry): Promise<void> =>
      entry.account.stop(),
    );
    this.managed.clear();

    await Promise.all([...stopping, ...this.detached]);
  }

  private async deliver(
    accessToken: string,
    event: MatrixForwardedEvent,
  ): Promise<void> {
    // Read at delivery, not at start: reconcile replaces the array outright.
    const targets = this.managed.get(accessToken)?.targets;
    if (!targets?.length) return;

    await forwardRoomEvent(event, accessToken, targets);
  }

  /**
   * Lets a removed account close in its own time. The replacement for its
   * device waits on the store lock anyway, so only shutdown needs to know the
   * close is still in flight.
   */
  private detach(account: ForwarderAccount): void {
    const closing = account
      .stop()
      .catch((error: unknown): void => {
        logWarn("Matrix account did not stop cleanly", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally((): void => {
        this.detached.delete(closing);
      });
    this.detached.add(closing);
  }

  private open(accessToken: string, group: AccountGroup): void {
    const account = this.createAccount({
      accessToken: accessToken,
      apiUrl: group.apiUrl,
      onEvent: (event: MatrixForwardedEvent): Promise<void> =>
        this.deliver(accessToken, event),
      storeDir: this.storeDir,
    });
    // Registered before the account starts, so its first event finds targets.
    this.managed.set(accessToken, {
      account: account,
      apiUrl: group.apiUrl,
      targets: group.targets,
    });
    logInfo("Matrix account added", {
      targets: group.targets.length,
      tokenHint: tokenHint(accessToken),
    });
    account.start();
  }
}

/**
 * One account per access token, fanned out to every webhook the token serves,
 * across planes. A token naming two homeservers is a config error, and the
 * later one is dropped rather than folded in: its agent would otherwise be fed
 * the first homeserver's rooms.
 */
export function groupConnectionsByToken(
  connections: readonly MatrixConnection[],
): Map<string, AccountGroup> {
  const grouped = new Map<string, AccountGroup>();
  for (const connection of connections) {
    const group = grouped.get(connection.botToken) ?? {
      apiUrl: connection.apiUrl,
      targets: [],
    };
    if (group.apiUrl !== connection.apiUrl) {
      logWarn(
        "One Matrix access token names two homeservers, skipping the second",
        {
          agentId: connection.agentId,
          tokenHint: tokenHint(connection.botToken),
        },
      );
      continue;
    }
    group.targets.push({
      agentId: connection.agentId,
      agentName: connection.agentName,
      webhookUrl: connection.webhookUrl,
    });
    grouped.set(connection.botToken, group);
  }

  return grouped;
}
