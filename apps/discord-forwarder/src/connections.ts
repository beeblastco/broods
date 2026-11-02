import type { ChannelConnection } from "@broods/convex/channel/connections";
import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { ConfigPlane } from "./config.ts";
import { logWarn } from "./log.ts";

// By name: the generated api types pull the whole backend in. ConvexClient takes only public
// refs, so this claims to be one; deploy-key auth is what admits the internalQuery.
const listConnections = makeFunctionReference<
  "query",
  { channel: string },
  ChannelConnection[]
>("channel/connections:listConnections");

export interface ConnectionWatch {
  close(): Promise<void>;
}

export interface ForwarderConnection {
  agentId: string;
  agentName: string;
  botToken: string;
  webhookUrl: string;
}

/** A silent (null) plane adds nothing; throws when every plane, or the empty list, is silent. */
export function combinePlaneAnswers<T>(
  planeNames: readonly string[],
  answers: readonly (T[] | null)[],
): T[] {
  if (answers.every((answer): boolean => answer === null)) {
    throw new Error(`No config plane answered: ${planeNames.join(", ")}`);
  }

  return answers.flatMap((answer): T[] => answer ?? []);
}

export function planeConnections(
  plane: ConfigPlane,
  rows: readonly ChannelConnection[],
): ForwarderConnection[] {
  return rows.map((row): ForwarderConnection => ({
    agentId: row.agentId,
    agentName: row.agentName,
    botToken: row.botToken,
    webhookUrl: `${plane.webhookBaseUrl}${row.webhookPath}`,
  }));
}

/** A plane's last answer stands while it reconnects, so a blip cannot close its sockets. */
export function watchChannelConnections<T>(
  channel: string,
  planes: readonly ConfigPlane[],
  resolve: (plane: ConfigPlane, rows: ChannelConnection[]) => T[],
  onChange: (connections: T[]) => void,
): ConnectionWatch {
  const latest = new Map<string, T[]>();
  const clients = planes.map((plane): ConvexClient => {
    const client = planeClient(plane);
    client.onUpdate(
      listConnections,
      { channel: channel },
      (rows: ChannelConnection[]): void => {
        latest.set(plane.name, resolve(plane, rows));
        onChange(
          combinePlaneAnswers(
            planes.map((entry): string => entry.name),
            planes.map((entry): T[] | null => latest.get(entry.name) ?? null),
          ),
        );
      },
      (error: Error): void => {
        logWarn("Config plane subscription error", {
          channel: channel,
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
      await Promise.all(clients.map((client): Promise<void> => client.close()));
    },
  };
}

function planeClient(plane: ConfigPlane): ConvexClient {
  const client = new ConvexClient(plane.convexUrl);
  // setAdminAuth is @internal and stripped from the public typings.
  (client as unknown as { setAdminAuth(key: string): void }).setAdminAuth(
    plane.deployKey,
  );

  return client;
}
