import { describe, expect, test } from "vitest";
import {
  BROWSER_TICKET_MAX_TTL_MS,
  BROWSER_TICKET_PREFIX,
  openBrowserTicket,
  sealBrowserTicket,
} from "../model/browserTicket";
import { sealSignedTicket } from "../model/stageSessionTicket";
import { openUserToken, sealUserToken } from "../model/userToken";

const SECRET = "bsig_test-secret";
const NOW = 1_700_000_000_000;
const ALICE = {
  userId: "alice@example.com",
  sandbox: "browser",
  expiresAt: NOW + 60_000,
  jti: "jti-1",
};

describe("browser tickets", () => {
  test("round-trips through seal and open", async () => {
    const ticket = await sealBrowserTicket(ALICE, SECRET, NOW);

    expect(ticket.startsWith(BROWSER_TICKET_PREFIX)).toBe(true);
    expect(await openBrowserTicket(ticket, SECRET, NOW)).toEqual(ALICE);
  });

  test("a user token never opens as a ticket, and a ticket never as a user token", async () => {
    const token = await sealUserToken(
      { userId: ALICE.userId, expiresAt: ALICE.expiresAt },
      SECRET,
      NOW,
    );
    // A user-token signature over a payload shaped like a ticket, so only the
    // key context can tell the two apart.
    const ticketShapedToken = await sealSignedTicket(
      "buat_",
      "broods-user-token:",
      ALICE,
      SECRET,
    );
    const ticket = await sealBrowserTicket(ALICE, SECRET, NOW);

    expect(await openBrowserTicket(token, SECRET, NOW)).toBeNull();
    expect(
      await openBrowserTicket(
        `${BROWSER_TICKET_PREFIX}${ticketShapedToken.slice("buat_".length)}`,
        SECRET,
        NOW,
      ),
    ).toBeNull();
    expect(await openUserToken(ticket, SECRET, NOW)).toBeNull();
    // A ticket's payload would read as a valid user token; its key does not.
    expect(
      await openUserToken(
        `buat_${ticket.slice(BROWSER_TICKET_PREFIX.length)}`,
        SECRET,
        NOW,
      ),
    ).toBeNull();
  });

  test("refuses a ticket signed with another stage's secret", async () => {
    const ticket = await sealBrowserTicket(ALICE, "bsig_other", NOW);

    expect(await openBrowserTicket(ticket, SECRET, NOW)).toBeNull();
  });

  test("refuses an expired ticket", async () => {
    const ticket = await sealBrowserTicket(ALICE, SECRET, NOW);

    expect(await openBrowserTicket(ticket, SECRET, ALICE.expiresAt)).toBeNull();
  });

  test("refuses to seal, or open, a lifetime past fifteen minutes", async () => {
    const tooLong = {
      ...ALICE,
      expiresAt: NOW + BROWSER_TICKET_MAX_TTL_MS + 1,
    };

    await expect(sealBrowserTicket(tooLong, SECRET, NOW)).rejects.toThrow(
      "Invalid browser ticket",
    );
    // Sealed by a signer whose clock ran two minutes ahead of core's.
    const ahead = await sealBrowserTicket(
      { ...ALICE, expiresAt: NOW + BROWSER_TICKET_MAX_TTL_MS + 120_000 },
      SECRET,
      NOW + 120_000,
    );
    expect(await openBrowserTicket(ahead, SECRET, NOW)).toBeNull();
  });

  test("refuses a user id with a colon and a secret that is not a signing secret", async () => {
    await expect(
      sealBrowserTicket({ ...ALICE, userId: "bob:x" }, SECRET, NOW),
    ).rejects.toThrow("Invalid browser ticket");
    await expect(sealBrowserTicket(ALICE, "bsk_runtime", NOW)).rejects.toThrow(
      "must start with bsig_",
    );
  });
});
