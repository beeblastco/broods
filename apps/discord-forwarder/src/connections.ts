/**
 * Watches Discord connections in every config plane the process serves.
 *
 * A Convex websocket subscription replaces the old fixed-interval poll: the
 * query re-runs only when a plane's `channelConnections` table actually
 * changes, so the standing function-call load is zero while nothing changes
 * and a new bot token reconciles the moment it is written.
 *
 * `packages/convex/channelConnections.ts` does the decryption, so this process
 * never holds `ACCOUNT_CONFIG_ENCRYPTION_SECRET` — only one deploy key per plane,
 * the same credential core authenticates storage reads with. That query is not
 * Discord-specific; this is the caller that asks it for `discord`.
 */

import type { ChannelConnection } from "@broods/convex/channelConnections";
import { ConvexClient } from "convex/browser";
import type { ConfigPlane } from "./config.ts";
import { logWarn } from "./log.ts";

// ConvexClient's typed `onUpdate` only accepts public function refs and the
// backend exposes this as an internalQuery, so the ref is cast at the boundary
// exactly as apps/core does. Deploy-key auth permits the call.
const internal: any = require("@broods/convex/_generated/api").internal;

/** Handle over every plane subscription; close it on shutdown. */
export interface ConnectionWatch {
  close(): Promise<void>;
}

/** A config-plane row with its own plane's gateway front door joined on. */
export interface ForwarderConnection {
  agentId: string;
  agentName: string;
  botToken: string;
  webhookUrl: string;
}

/**
 * Flattens what the planes answered, treating a silent plane as contributing
 * nothing rather than as an outage. Throws only when every plane was silent,
 * which is the one case the caller must not reconcile on.
 *
 * Separate from the transport so the rule is pinned by a test: getting it wrong
 * once meant a backend that was not live yet stopped every other plane from
 * ever opening a socket.
 */
export function combinePlaneAnswers(
  planeNames: readonly string[],
  answers: readonly (ForwarderConnection[] | null)[],
): ForwarderConnection[] {
  // `every` is true for an empty list too, which is the right answer: a process
  // with no planes has nothing to watch and must not report itself ready.
  if (answers.every((answer) => answer === null)) {
    throw new Error(`No config plane answered: ${planeNames.join(", ")}`);
  }

  return answers.flatMap((answer) => answer ?? []);
}

/**
 * Resolves a plane's rows against its own gateway. The config plane returns a
 * path and never learns which front door sits in front of it, which is what lets
 * one process serve deployments that answer on different hosts.
 */
export function planeConnections(
  plane: ConfigPlane,
  rows: readonly ChannelConnection[],
): ForwarderConnection[] {
  return rows.map((row) => ({
    agentId: row.agentId,
    agentName: row.agentName,
    botToken: row.botToken,
    webhookUrl: `${plane.webhookBaseUrl}${row.webhookPath}`,
  }));
}

/**
 * One entry per deployed agent that configures a Discord bot token, across every
 * plane, delivered whenever any plane's answer changes.
 *
 * A plane is isolated from its neighbours: the websocket client reconnects on
 * its own, and until a plane answers again its last snapshot keeps contributing,
 * so a blip cannot look like "every token here was deleted" and close its
 * sockets. A plane that has never answered contributes nothing, which is what
 * lets this process serve a deployment whose backend is not live yet — and
 * `onChange` never fires before at least one plane has answered, so total
 * silence never reconciles at all.
 */
export function watchDiscordConnections(
  planes: readonly ConfigPlane[],
  onChange: (connections: ForwarderConnection[]) => void,
): ConnectionWatch {
  const latest = new Map<string, ForwarderConnection[]>();
  const clients = planes.map((plane) => {
    const client = planeClient(plane);
    client.onUpdate(
      internal.channelConnections.listConnections,
      { channel: "discord" },
      (rows: ChannelConnection[]) => {
        latest.set(plane.name, planeConnections(plane, rows));
        onChange(
          combinePlaneAnswers(
            planes.map((entry) => entry.name),
            planes.map((entry) => latest.get(entry.name) ?? null),
          ),
        );
      },
      (error: Error) => {
        logWarn("Config plane subscription error", {
          error: error.message,
          plane: plane.name,
          reusing: latest.get(plane.name)?.length ?? 0,
        });
      },
    );

    return client;
  });

  return {
    close: async (): Promise<void> => {
      await Promise.all(clients.map((client) => client.close()));
    },
  };
}

/** A websocket client for one plane, authenticated with its deploy key. */
function planeClient(plane: ConfigPlane): ConvexClient {
  const client = new ConvexClient(plane.convexUrl);
  // setAdminAuth is marked @internal and stripped from the public typings,
  // the same as on ConvexHttpClient in apps/core.
  (client as unknown as { setAdminAuth(key: string): void }).setAdminAuth(
    plane.deployKey,
  );

  return client;
}
