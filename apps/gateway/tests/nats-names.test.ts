import { afterEach, expect, test } from "bun:test";
import {
  natsNames,
  readConversationStream,
  type NatsConnection,
} from "../../core/src/shared/nats.ts";
import { natsSpentTickets } from "../src/terminal.ts";

const originalEnvironment = process.env.DEPLOYMENT_ENVIRONMENT;

afterEach((): void => {
  if (originalEnvironment === undefined)
    delete process.env.DEPLOYMENT_ENVIRONMENT;
  else process.env.DEPLOYMENT_ENVIRONMENT = originalEnvironment;
});

test("the gateway reads the stream core writes, in the same environment", async (): Promise<void> => {
  process.env.DEPLOYMENT_ENVIRONMENT = "production";
  const { connection, used } = recordingConnection();

  await readConversationStream({
    connection: connection,
    accountId: "acct1",
    agentId: "agent1",
    conversationKey: "conv-1",
  });

  expect(natsNames("production").responseSubjectWildcard).toBe(
    "production.v1.*.*.ws.response.*",
  );
  expect(used.consumed[0]?.stream).toBe("WS_RESPONSES_production");
  expect(used.consumed[0]?.subject.startsWith("production.v1.acct1.")).toBe(
    true,
  );
});

test("the gateway spends terminal tickets in its own environment's bucket", async (): Promise<void> => {
  const { connection, used } = recordingConnection();
  const spentTickets = natsSpentTickets(
    async (): Promise<NatsConnection> => connection,
  );

  for (const environment of ["production", "development"]) {
    process.env.DEPLOYMENT_ENVIRONMENT = environment;
    await spentTickets.spend("ticket");
  }

  expect(used.buckets).toEqual([
    natsNames("production").spentTicketBucket,
    natsNames("development").spentTicketBucket,
  ]);
  expect(used.buckets[0]).not.toBe(used.buckets[1]);
});

function recordingConnection(): {
  connection: NatsConnection;
  used: {
    buckets: string[];
    consumed: { stream: string; subject: string }[];
  };
} {
  const used = {
    buckets: [] as string[],
    consumed: [] as { stream: string; subject: string }[],
  };
  const connection = {
    jetstreamManager: async (): Promise<unknown> => ({
      streams: {
        info: async (): Promise<never> => {
          throw new Error("stream not found");
        },
        add: async (): Promise<void> => {},
      },
    }),
    jetstream: (): unknown => ({
      consumers: {
        get: async (
          stream: string,
          options: { filterSubjects: string },
        ): Promise<unknown> => {
          used.consumed.push({
            stream: stream,
            subject: options.filterSubjects,
          });

          return { consume: async (): Promise<unknown> => ({}) };
        },
      },
      views: {
        kv: async (name: string): Promise<unknown> => {
          used.buckets.push(name);

          return { create: async (): Promise<number> => 1 };
        },
      },
    }),
  } as unknown as NatsConnection;

  return { connection: connection, used: used };
}
