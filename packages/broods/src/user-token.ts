/**
 * Server-side signing of end-user tokens and browser tickets. The runtime key
 * (`bsk_`) sits in a frontend, so it cannot say who is using it; your backend,
 * which knows the signed-in user, signs a short-lived token with the stage's
 * signing secret (`bsig_`, from the dashboard's Runtime key tab) and hands it
 * to the frontend. Core then keeps every conversation that request touches
 * under that user, so one visitor can never read or steer another's. A
 * browser ticket, signed with the same secret, lets that user's browser
 * extension connect to a `scope: "user"` machine sandbox. Never ship the
 * signing secret to a browser.
 */

import {
  BROWSER_TICKET_DEFAULT_TTL_MS,
  BROWSER_TICKET_MAX_TTL_MS,
  sealBrowserTicket,
} from "../../convex/model/browserTicket.ts";
import {
  sealUserToken,
  USER_TOKEN_DEFAULT_TTL_MS,
  USER_TOKEN_HEADER,
  USER_TOKEN_MAX_TTL_MS,
} from "../../convex/model/userToken.ts";

export { BROWSER_TICKET_MAX_TTL_MS, USER_TOKEN_HEADER, USER_TOKEN_MAX_TTL_MS };

/**
 * The env var `signUserToken` reads the signing secret from, and the one
 * `broods dev` / `broods deploy` write it to in `.env.local`.
 */
export const USER_TOKEN_SECRET_ENV = "BROODS_USER_TOKEN_SECRET";

export interface SignBrowserTicketInput {
  /** The same id your user tokens name for this user. Letters, digits and `._@+=-`, at most 128. */
  userId: string;
  /** The name of the `scope: "user"` machine sandbox the extension serves. */
  sandbox: string;
  /** Lifetime in ms. Defaults to 10 minutes, at most 15. */
  ttlMs?: number;
  /** The stage's `bsig_` signing secret. Defaults to `BROODS_USER_TOKEN_SECRET`. */
  secret?: string;
}

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
 * A browser ticket for one user's extension: hand it to `connectBrowser`'s
 * `getTicket`. Each ticket opens one socket or one refresh, once, so sign a
 * fresh one per call. Your backend decides who gets one, after it checked
 * that user is signed in.
 * @throws when no signing secret is set or an input is out of range
 */
export async function signBrowserTicket(
  input: SignBrowserTicketInput,
): Promise<string> {
  return await sealBrowserTicket(
    {
      userId: input.userId,
      sandbox: input.sandbox,
      expiresAt: Date.now() + (input.ttlMs ?? BROWSER_TICKET_DEFAULT_TTL_MS),
      jti: crypto.randomUUID(),
    },
    signingSecret("signBrowserTicket", input.secret),
  );
}

/**
 * A user token for the runtime key: pass it as `userToken` to `BroodsClient`
 * or `BroodsWebSocketClient`, or send it in the `X-Broods-User-Token` header.
 * @throws when no signing secret is set or an input is out of range
 */
export async function signUserToken(
  input: SignUserTokenInput,
): Promise<string> {
  return await sealUserToken(
    {
      userId: input.userId,
      ...(input.conversations ? { conversations: input.conversations } : {}),
      expiresAt: Date.now() + (input.ttlMs ?? USER_TOKEN_DEFAULT_TTL_MS),
    },
    signingSecret("signUserToken", input.secret),
  );
}

function signingSecret(caller: string, secret: string | undefined): string {
  const value = secret ?? process.env[USER_TOKEN_SECRET_ENV];
  if (!value) {
    throw new Error(
      `${caller} needs the stage's signing secret: pass secret or set ${USER_TOKEN_SECRET_ENV}. \`broods dev\` and \`broods deploy\` write it to .env.local; the dashboard's Runtime key tab rotates it.`,
    );
  }

  return value;
}
