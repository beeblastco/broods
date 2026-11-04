import { beforeAll, describe, expect, it } from "bun:test";
import {
  OBSERVABILITY_TICKET_PREFIX,
  sealObservabilityTicket,
} from "@broods/convex/model/observabilityTicket";
import { resolveBearerAuth } from "../src/shared/auth.ts";

const SECRET = "ticket-secret";

beforeAll((): void => {
  process.env.STAGE_TICKET_SECRET = SECRET;
});

describe("the read-only logs ticket in core", () => {
  it("resolves to no credential, so no run, status or sandbox route takes it", async () => {
    const ticket = await sealObservabilityTicket(
      {
        accountId: "a",
        endpointId: "e",
        projectSlug: "p",
        stageSlug: "s",
        expiresAt: Date.now() + 60_000,
      },
      SECRET,
    );

    expect(ticket.startsWith(OBSERVABILITY_TICKET_PREFIX)).toBe(true);
    expect(
      await resolveBearerAuth({ authorization: `Bearer ${ticket}` }),
    ).toBeNull();
  });
});
