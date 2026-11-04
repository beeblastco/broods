import { describe, expect, test } from "vitest";
import {
  APPLY_TICKET_TTL_MS,
  openApplyTicket,
  sealApplyTicket,
} from "../model/applyTicket";
import { openStageSessionTicket } from "../model/stageSessionTicket";

const SECRET = "stage-ticket-secret";
const TICKET = {
  accountId: "a",
  projectId: "p",
  stageId: "s",
  authId: "user_1",
};

describe("apply ticket", () => {
  test("opens under its own secret until it expires, and never as a stage ticket", async () => {
    const now = 1_000_000;
    const ticket = await sealApplyTicket(TICKET, SECRET, now);

    expect(ticket.startsWith("bdap_")).toBe(true);
    expect(await openApplyTicket(ticket, SECRET, now)).toEqual({
      ...TICKET,
      expiresAt: now + APPLY_TICKET_TTL_MS,
    });
    expect(await openApplyTicket(ticket, "other", now)).toBeNull();
    expect(
      await openApplyTicket(ticket, SECRET, now + APPLY_TICKET_TTL_MS),
    ).toBeNull();
    expect(
      await openStageSessionTicket(`bdts_${ticket.slice(5)}`, SECRET),
    ).toBeNull();
  });
});
