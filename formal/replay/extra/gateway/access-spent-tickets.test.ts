import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { NatsConnection } from "nats.ws";
import { natsSpentTickets } from "../../../../apps/gateway/src/terminal.ts";
import { attachmentStorePrefix } from "../../../../apps/core/src/shared/media-ticket.ts";

interface FakeBucket {
  created: string[];
  deleted: string[];
  connection: () => Promise<NatsConnection>;
}

function fakeBucket(): FakeBucket {
  const created: string[] = [];
  const deleted: string[] = [];
  const kv = {
    create: async (key: string): Promise<number> => {
      created.push(key);

      return 1;
    },
    delete: async (key: string): Promise<void> => {
      deleted.push(key);
    },
  };
  const connection = {
    jetstream: () => ({ views: { kv: async () => kv } }),
  } as unknown as NatsConnection;

  return {
    created: created,
    deleted: deleted,
    connection: async (): Promise<NatsConnection> => connection,
  };
}

test.each([["st1.token"], ["another-ticket"]])(
  "a spent ticket is stored under its SHA-256, never in clear: %s",
  async (token: string): Promise<void> => {
    const bucket = fakeBucket();
    const tickets = natsSpentTickets(bucket.connection);
    const digest = createHash("sha256").update(token).digest("hex");

    expect(await tickets.spend(token)).toBe(true);
    await tickets.release(token);

    expect(bucket.created).toEqual([digest]);
    expect(bucket.deleted).toEqual([digest]);
  },
);

test.each([
  ["acct_1", "attachments/acct_1/"],
  ["acct/with space", "attachments/acct%2Fwith%20space/"],
])(
  "attachment prefix encodes %s",
  (accountId: string, prefix: string): void => {
    expect(attachmentStorePrefix(accountId)).toBe(prefix);
  },
);
