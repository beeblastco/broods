import { describe, expect, test } from "bun:test";

import { isSecretName } from "../../../../packages/convex/model/secretNames";
import {
  bytesToBase64Url,
  openStageSessionTicket,
  STAGE_SESSION_TICKET_PREFIX,
  ticketKey,
} from "../../../../packages/convex/model/stageSessionTicket";
import {
  openUserToken,
  sealUserToken,
  USER_TOKEN_PREFIX,
} from "../../../../packages/convex/model/userToken";

const SECRET = "bsig_fixture-secret";
const NOW = 1_800_000_000_000;
const ENCODER = new TextEncoder();

async function forgeSigned(
  prefix: string,
  keyContext: string,
  rawJson: string,
): Promise<string> {
  const payload = bytesToBase64Url(ENCODER.encode(rawJson));
  const signature = await crypto.subtle.sign(
    { name: "HMAC", hash: "SHA-256" },
    await ticketKey(keyContext, SECRET),
    ENCODER.encode(payload),
  );

  return `${prefix}${payload}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

describe("openStageSessionTicket", (): void => {
  test("refuses a token with no signature", async (): Promise<void> => {
    const token = `${STAGE_SESSION_TICKET_PREFIX}${bytesToBase64Url(ENCODER.encode("{}"))}`;

    expect(await openStageSessionTicket(token, SECRET, NOW)).toBeNull();
  });

  test("refuses a signed payload that is not an object", async (): Promise<void> => {
    const token = await forgeSigned(
      STAGE_SESSION_TICKET_PREFIX,
      "stage-session-ticket:",
      "null",
    );

    expect(await openStageSessionTicket(token, SECRET, NOW)).toBeNull();
  });
});

describe("openUserToken", (): void => {
  test("round-trips the conversations a token is limited to", async (): Promise<void> => {
    const token = await sealUserToken(
      { userId: "user_1", conversations: ["a", "b"], expiresAt: NOW + 60_000 },
      SECRET,
      NOW,
    );

    expect(await openUserToken(token, SECRET, NOW)).toEqual({
      userId: "user_1",
      conversations: ["a", "b"],
      expiresAt: NOW + 60_000,
    });
  });

  test.each([
    ["an untrimmed key", [" a"]],
    ["an empty key", [""]],
    ["too many keys", Array.from({ length: 101 }, (_, i): string => `k${i}`)],
  ])(
    "refuses to seal %s",
    async (_name: string, conversations: string[]): Promise<void> => {
      await expect(
        sealUserToken(
          {
            userId: "user_1",
            conversations: conversations,
            expiresAt: NOW + 1_000,
          },
          SECRET,
          NOW,
        ),
      ).rejects.toThrow("Invalid user token");
    },
  );

  test("refuses a sealed credential that is not text", async (): Promise<void> => {
    const token = await forgeSigned(
      USER_TOKEN_PREFIX,
      "broods-user-token:",
      JSON.stringify({
        userId: "user_1",
        expiresAt: NOW + 60_000,
        credentialSealed: 5,
      }),
    );

    expect(await openUserToken(token, SECRET, NOW)).toBeNull();
  });
});

describe("isSecretName", (): void => {
  test("keeps judging correctly after the cache fills and resets", (): void => {
    for (let index = 0; index < 4_100; index += 1) {
      isSecretName(`field${index}`);
    }

    expect(isSecretName("apiKey")).toBe(true);
    expect(isSecretName("title")).toBe(false);
  });
});
