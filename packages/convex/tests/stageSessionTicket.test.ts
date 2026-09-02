import { describe, expect, test } from "vitest";
import {
  openStageSessionTicket,
  sealStageSessionTicket,
  STAGE_SESSION_TICKET_PREFIX,
} from "../model/stageSessionTicket";

const SECRET = "service-secret";
const TICKET = {
  accountId: "acct_1",
  endpointId: "stage-abcd1234",
  projectSlug: "shop",
  stageSlug: "development",
  expiresAt: Date.now() + 60_000,
};

describe("stage session tickets", () => {
  test("round-trips through seal and open", async () => {
    const token = await sealStageSessionTicket(TICKET, SECRET);

    expect(token.startsWith(STAGE_SESSION_TICKET_PREFIX)).toBe(true);
    expect(await openStageSessionTicket(token, SECRET)).toEqual(TICKET);
  });

  test("rejects a ticket signed with another secret", async () => {
    const token = await sealStageSessionTicket(TICKET, "other-secret");

    expect(await openStageSessionTicket(token, SECRET)).toBeNull();
  });

  test("rejects a tampered payload", async () => {
    const token = await sealStageSessionTicket(TICKET, SECRET);
    const [payload, signature] = token
      .slice(STAGE_SESSION_TICKET_PREFIX.length)
      .split(".");
    const forged = await sealStageSessionTicket(
      { ...TICKET, accountId: "acct_2" },
      SECRET,
    );
    const forgedPayload = forged
      .slice(STAGE_SESSION_TICKET_PREFIX.length)
      .split(".")[0];

    expect(
      await openStageSessionTicket(
        `${STAGE_SESSION_TICKET_PREFIX}${forgedPayload}.${signature}`,
        SECRET,
      ),
    ).toBeNull();
    expect(
      await openStageSessionTicket(
        `${STAGE_SESSION_TICKET_PREFIX}${payload}.${signature}.extra`,
        SECRET,
      ),
    ).toBeNull();
  });

  test("rejects an expired ticket and anything without the prefix", async () => {
    const token = await sealStageSessionTicket(TICKET, SECRET);

    expect(
      await openStageSessionTicket(token, SECRET, TICKET.expiresAt + 1),
    ).toBeNull();
    expect(await openStageSessionTicket("fp_agent_not-a-ticket", SECRET)).toBe(
      null,
    );
  });
});
