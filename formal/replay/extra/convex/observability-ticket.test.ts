import { describe, expect, test } from "bun:test";

import {
  OBSERVABILITY_TICKET_TTL_MS,
  observabilityTicketExpiry,
  openObservabilityTicket,
  sealObservabilityTicket,
  type ObservabilityTicket,
} from "../../../../packages/convex/model/observabilityTicket";
import { sealSignedTicket } from "../../../../packages/convex/model/stageSessionTicket";

const SECRET = "ticket-secret";
const NOW = 1_800_000_000_000;

function ticket(expiresAt: number): ObservabilityTicket {
  return {
    accountId: "acct_1",
    endpointId: "ep_1",
    projectSlug: "shop",
    stageSlug: "dev",
    expiresAt: expiresAt,
  };
}

describe("observabilityTicketExpiry", (): void => {
  test("is the ttl from now when the login outlasts it", (): void => {
    expect(observabilityTicketExpiry(NOW, undefined)).toBe(
      NOW + OBSERVABILITY_TICKET_TTL_MS,
    );
    expect(
      observabilityTicketExpiry(NOW, NOW + 10 * OBSERVABILITY_TICKET_TTL_MS),
    ).toBe(NOW + OBSERVABILITY_TICKET_TTL_MS);
  });

  test("never outlives the login that asked", (): void => {
    expect(observabilityTicketExpiry(NOW, NOW + 1_000)).toBe(NOW + 1_000);
  });
});

describe("openObservabilityTicket", (): void => {
  test("returns the ticket while it is live and null from its expiry on", async (): Promise<void> => {
    const sealed = await sealObservabilityTicket(ticket(NOW + 1_000), SECRET);

    expect(await openObservabilityTicket(sealed, SECRET, NOW)).toEqual(
      ticket(NOW + 1_000),
    );
    expect(
      await openObservabilityTicket(sealed, SECRET, NOW + 1_000),
    ).toBeNull();
    expect(
      await openObservabilityTicket(sealed, SECRET, NOW + 2_000),
    ).toBeNull();
  });

  test("defaults to the clock", async (): Promise<void> => {
    const live = await sealObservabilityTicket(
      ticket(Date.now() + 60_000),
      SECRET,
    );
    const dead = await sealObservabilityTicket(
      ticket(Date.now() - 60_000),
      SECRET,
    );

    expect(await openObservabilityTicket(live, SECRET)).not.toBeNull();
    expect(await openObservabilityTicket(dead, SECRET)).toBeNull();
  });

  test("refuses a wrong secret, a foreign token and a payload of the wrong shape", async (): Promise<void> => {
    const sealed = await sealObservabilityTicket(ticket(NOW + 1_000), SECRET);
    const misshapen = await sealSignedTicket(
      "bdob_",
      "observability-read-ticket:",
      { accountId: "acct_1", expiresAt: "soon" },
      SECRET,
    );

    expect(await openObservabilityTicket(sealed, "other", NOW)).toBeNull();
    expect(await openObservabilityTicket("bdst_x.y", SECRET, NOW)).toBeNull();
    expect(await openObservabilityTicket(misshapen, SECRET, NOW)).toBeNull();
  });
});
