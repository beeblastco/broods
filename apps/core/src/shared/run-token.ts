/**
 * Run tokens (`brt_…`): a stateless HMAC-signed bearer for one agent run,
 * handed to its sandbox code so it can read that agent's runs.
 * Signed with a key HKDF-derived from STAGE_TICKET_SECRET under its own info
 * string, so a run token can never open a stage ticket or the reverse. Core
 * is the only minter and verifier; the config plane refuses the prefix.
 * The same secret also tags the subagent conversation keys core mints, under
 * another info string.
 */

import { RUN_TOKEN_PREFIX } from "@broods/convex/model/principal";
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { requireEnv, WORKER_TIMEOUT_BUDGET_MS } from "./env.ts";

const HKDF_INFO = "broods-run-token";
const KEY_BYTES = 32;
const TTL_MARGIN_MS = 5 * 60 * 1000;
const TTL_MAX_MS = 2 * 60 * 60 * 1000;

/** Outlives the run budget by a margin, capped: a leaked token stays short. */
const RUN_TOKEN_TTL_MS = Math.min(
  WORKER_TIMEOUT_BUDGET_MS + TTL_MARGIN_MS,
  TTL_MAX_MS,
);

/** Whose runs the bearer reads. Nothing else is signed, so nothing goes unchecked. */
export interface RunTokenSubject {
  accountId: string;
  agentId: string;
}

type RunTokenClaims = RunTokenSubject & { exp: number };

const SUBAGENT_KEY_HKDF_INFO = "broods-subagent-key";
const SUBAGENT_KEY_TAG_HEX = 32;

// One derived key per info string and secret value, so a rotation re-derives
// and a test can swap it.
const derivedKeys = new Map<string, { secret: string; key: Buffer }>();

/** Verify signature and expiry; null for anything else. */
export function openRunToken(
  token: string,
  now = Date.now(),
): RunTokenSubject | null {
  if (!token.startsWith(RUN_TOKEN_PREFIX)) return null;
  const [payload, signature, ...rest] = token
    .slice(RUN_TOKEN_PREFIX.length)
    .split(".");
  if (!payload || !signature || rest.length > 0) return null;
  const expected = sign(payload);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null;
  }
  let claims: RunTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof claims.exp !== "number" || claims.exp <= now) return null;

  return { accountId: claims.accountId, agentId: claims.agentId };
}

/** Sign an agent's bearer. The payload is readable by its holder, so it carries the two ids and an expiry. */
export function sealRunToken(
  subject: RunTokenSubject,
  now = Date.now(),
  ttlMs = RUN_TOKEN_TTL_MS,
): string {
  const claims: RunTokenClaims = {
    accountId: subject.accountId,
    agentId: subject.agentId,
    exp: now + ttlMs,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");

  return `${RUN_TOKEN_PREFIX}${payload}.${sign(payload).toString("base64url")}`;
}

function derivedKey(info: string): Buffer {
  const secret = requireEnv("STAGE_TICKET_SECRET");
  const cached = derivedKeys.get(info);
  if (cached?.secret === secret) return cached.key;
  const key = Buffer.from(hkdfSync("sha256", secret, "", info, KEY_BYTES));
  derivedKeys.set(info, { secret: secret, key: key });

  return key;
}

function sign(payload: string): Buffer {
  return createHmac("sha256", derivedKey(HKDF_INFO)).update(payload).digest();
}

/**
 * The tag that proves core minted a subagent conversation key for this scope:
 * a direct-API caller can name a conversation in the same form, never with a
 * valid tag.
 */
export function subagentKeyTag(scope: string): string {
  return createHmac("sha256", derivedKey(SUBAGENT_KEY_HKDF_INFO))
    .update(scope)
    .digest("hex")
    .slice(0, SUBAGENT_KEY_TAG_HEX);
}
