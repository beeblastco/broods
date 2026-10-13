import { describe, expect, test } from "vitest";
import {
  openStageSessionTicket,
  sealStageSessionTicket,
} from "../model/stageSessionTicket";
import {
  openUserToken,
  sealUserToken,
  USER_TOKEN_MAX_TTL_MS,
  USER_TOKEN_PREFIX,
  userConversationKey,
  userOwnsConversation,
} from "../model/userToken";

const SECRET = "bsig_test-secret";
const NOW = 1_700_000_000_000;
const ALICE = { userId: "alice@example.com", expiresAt: NOW + 60_000 };

describe("user tokens", () => {
  test("round-trips through seal and open", async () => {
    const token = await sealUserToken(ALICE, SECRET, NOW);

    expect(token.startsWith(USER_TOKEN_PREFIX)).toBe(true);
    expect(await openUserToken(token, SECRET, NOW)).toEqual(ALICE);
  });

  test("refuses a token signed with another secret", async () => {
    const token = await sealUserToken(ALICE, "bsig_other", NOW);

    expect(await openUserToken(token, SECRET, NOW)).toBeNull();
  });

  test("refuses a payload swapped under another signature", async () => {
    const alice = await sealUserToken(ALICE, SECRET, NOW);
    const bob = await sealUserToken({ ...ALICE, userId: "bob" }, SECRET, NOW);
    const [, aliceSignature] = alice.slice(USER_TOKEN_PREFIX.length).split(".");
    const [bobPayload] = bob.slice(USER_TOKEN_PREFIX.length).split(".");

    expect(
      await openUserToken(
        `${USER_TOKEN_PREFIX}${bobPayload}.${aliceSignature}`,
        SECRET,
        NOW,
      ),
    ).toBeNull();
  });

  test("refuses an expired token", async () => {
    const token = await sealUserToken(ALICE, SECRET, NOW);

    expect(await openUserToken(token, SECRET, ALICE.expiresAt)).toBeNull();
  });

  test("refuses to seal past the longest lifetime", async () => {
    await expect(
      sealUserToken(
        { userId: "alice", expiresAt: NOW + USER_TOKEN_MAX_TTL_MS + 30_000 },
        SECRET,
        NOW,
      ),
    ).rejects.toThrow("Invalid user token");
  });

  test("refuses a user id with a colon, so the namespace splits one way", async () => {
    await expect(
      sealUserToken({ ...ALICE, userId: "bob:x" }, SECRET, NOW),
    ).rejects.toThrow("Invalid user token");
  });

  test("refuses a secret that is not a signing secret", async () => {
    await expect(sealUserToken(ALICE, "bsk_runtime", NOW)).rejects.toThrow(
      "must start with bsig_",
    );
  });

  test("a stage ticket and a user token do not open each other", async () => {
    const ticket = await sealStageSessionTicket(
      {
        accountId: "acct_1",
        endpointId: "stage-abcd1234",
        projectId: "p",
        projectSlug: "p",
        stageId: "s",
        stageSlug: "s",
        expiresAt: NOW + 60_000,
      },
      SECRET,
    );
    const token = await sealUserToken(ALICE, SECRET, NOW);

    expect(await openUserToken(ticket, SECRET, NOW)).toBeNull();
    expect(await openStageSessionTicket(token, SECRET)).toBeNull();
  });

  test("namespaces conversation keys by user", () => {
    expect(userConversationKey(ALICE, "chat-1")).toBe(
      "bsu:alice@example.com:chat-1",
    );
    expect(userConversationKey(ALICE, "bsu:alice@example.com:chat-1")).toBe(
      "bsu:alice@example.com:chat-1",
    );
    expect(userOwnsConversation(ALICE, "bsu:bob:chat-1")).toBe(false);
    expect(userOwnsConversation(ALICE, "chat-1")).toBe(false);
    expect(userOwnsConversation(ALICE, "bsu:alice@example.com:")).toBe(false);
  });

  test("a token listing conversations reaches only those", () => {
    const listed = { ...ALICE, conversations: ["chat-1"] };

    expect(userConversationKey(listed, "chat-1")).toBe(
      "bsu:alice@example.com:chat-1",
    );
    expect(userConversationKey(listed, "chat-2")).toBeNull();
  });
});
