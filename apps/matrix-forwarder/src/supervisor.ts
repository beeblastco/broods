import type {
  MatrixSendRequest,
  MatrixTypingRequest,
} from "../../core/src/shared/matrix-wire.ts";
import type { ForwardTarget } from "../../discord-forwarder/src/forward.ts";
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
import { normalizeApiUrl } from "./matrix.ts";

// Injected so tests never load the native crypto module.
type AccountFactory = (options: MatrixAccountOptions) => ForwarderAccount;

interface AccountGroup {
  apiUrl: string;
  targets: ForwardTarget[];
}

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
  private readonly detached = new Set<Promise<void>>();
  private readonly managed = new Map<string, ManagedAccount>();
  private readonly storeDir: string;

  constructor(storeDir: string, createAccount: AccountFactory) {
    this.createAccount = createAccount;
    this.storeDir = storeDir;
  }

  account(accessToken: string): ForwarderAccount | undefined {
    return this.managed.get(accessToken)?.account;
  }

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
      storeDir: this.storeDir,
      // Read at delivery, not at start: reconcile replaces the array outright.
      targets: (): readonly ForwardTarget[] =>
        this.managed.get(accessToken)?.targets ?? [],
    });
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

// One account per token, since two sync loops on one would deliver twice and share a store. A
// token's second homeserver is dropped, not merged: its agent would get the first one's rooms.
export function groupConnectionsByToken(
  connections: readonly MatrixConnection[],
): Map<string, AccountGroup> {
  const grouped = new Map<string, AccountGroup>();
  for (const connection of connections) {
    const apiUrl = normalizeApiUrl(connection.apiUrl);
    const group = grouped.get(connection.botToken) ?? {
      apiUrl: apiUrl,
      targets: [],
    };
    if (group.apiUrl !== apiUrl) {
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
