import {
  sealUserToken,
  USER_TOKEN_DEFAULT_TTL_MS,
  USER_TOKEN_HEADER,
  USER_TOKEN_MAX_TTL_MS,
} from "../../convex/model/userToken.ts";

export { USER_TOKEN_HEADER, USER_TOKEN_MAX_TTL_MS };

export const USER_TOKEN_SECRET_ENV = "BROODS_USER_TOKEN_SECRET";

export interface SignUserTokenInput {
  /** Your own id for the signed-in user. Letters, digits and `._@+=-`, at most 128. */
  userId: string;
  /** Conversation keys this user may use. Omit to allow any key, still under this user only. */
  conversations?: string[];
  /** Lifetime in ms. Defaults to 10 minutes, at most 60. */
  ttlMs?: number;
  /** The stage's `bsig_` signing secret. Defaults to `BROODS_USER_TOKEN_SECRET`. */
  secret?: string;
}

/**
 * Signs a short-lived token for your signed-in user, so core keeps that user's conversations
 * apart. Call it on your backend only: never ship the `bsig_` secret to a browser. Pass the
 * token as `userToken` to `BroodsClient` or `BroodsWebSocketClient`.
 * @throws when no signing secret is set or an input is out of range
 */
export async function signUserToken(
  input: SignUserTokenInput,
): Promise<string> {
  const secret = input.secret ?? process.env[USER_TOKEN_SECRET_ENV];
  if (!secret) {
    throw new Error(
      `signUserToken needs the stage's signing secret: pass secret or set ${USER_TOKEN_SECRET_ENV}. \`broods dev\` and \`broods deploy\` write it to .env.local; the dashboard's Runtime key tab rotates it.`,
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
