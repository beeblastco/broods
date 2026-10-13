/**
 * Server-side signing of end-user tokens. The runtime key (`bsk_`) sits in a
 * frontend, so it cannot say who is using it; your backend, which knows the
 * signed-in user, signs a short-lived token with the stage's signing secret
 * (`bsig_`, from the dashboard's Runtime key tab) and hands it to the
 * frontend. Core then keeps every conversation that request touches under
 * that user, so one visitor can never read or steer another's. Never ship the
 * signing secret to a browser.
 */

import {
  sealUserToken,
  USER_TOKEN_DEFAULT_TTL_MS,
  USER_TOKEN_HEADER,
  USER_TOKEN_MAX_TTL_MS,
} from "../../convex/model/userToken.ts";

export { USER_TOKEN_HEADER, USER_TOKEN_MAX_TTL_MS };

export interface SignUserTokenInput {
  /** Your own id for the signed-in user. Letters, digits and `._@+=-`, at most 128. */
  userId: string;
  /**
   * The conversation keys this user may use. Omit to allow any key, which
   * still lands under this user only.
   */
  conversations?: string[];
  /** Lifetime in ms. Defaults to 10 minutes, at most 60. */
  ttlMs?: number;
  /** The stage's `bsig_` signing secret. Defaults to `BROODS_USER_TOKEN_SECRET`. */
  secret?: string;
}

/**
 * A user token for the runtime key: pass it as `userToken` to `BroodsClient`
 * or `BroodsWebSocketClient`, or send it in the `X-Broods-User-Token` header.
 * @throws when no signing secret is set or an input is out of range
 */
export async function signUserToken(
  input: SignUserTokenInput,
): Promise<string> {
  const secret = input.secret ?? process.env.BROODS_USER_TOKEN_SECRET;
  if (!secret) {
    throw new Error(
      "signUserToken needs the stage's signing secret: pass secret or set BROODS_USER_TOKEN_SECRET. Generate it on the dashboard's Runtime key tab.",
    );
  }

  return await sealUserToken(
    {
      userId: input.userId,
      ...(input.conversations ? { conversations: input.conversations } : {}),
      expiresAt: Date.now() + (input.ttlMs ?? USER_TOKEN_DEFAULT_TTL_MS),
    },
    secret,
  );
}
