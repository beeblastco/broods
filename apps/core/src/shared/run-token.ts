/**
 * Run tokens (`fp_run_…`): a stateless HMAC-signed bearer for one agent run,
 * handed to its sandbox code so it can call back into the API as that agent.
 * Signed with a key HKDF-derived from STAGE_TICKET_SECRET under its own info
 * string, so a run token can never open a stage ticket or the reverse. Core
 * is the only minter and verifier; the config plane refuses the prefix.
 */

import { RUN_TOKEN_PREFIX } from "@broods/convex/model/principal";
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { chainWithoutNames, type Principal } from "./domain/principal.ts";
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

type RunTokenClaims = Principal & { exp: number };

// One derived key per secret value, so a rotation re-derives and a test can swap it.
let derivedKey: { secret: string; key: Buffer } | undefined;

/** Verify signature and expiry; null for anything else. The chain comes back without display names. */
export function openRunToken(
  token: string,
  now = Date.now(),
): Principal | null {
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
  const { exp: _exp, ...principal } = claims;

  return principal;
}

/** Sign a principal into a bearer. The payload is readable by its holder, so the chain carries ids and kinds, never a display name. */
export function sealRunToken(
  principal: Principal,
  now = Date.now(),
  ttlMs = RUN_TOKEN_TTL_MS,
): string {
  const claims: RunTokenClaims = {
    ...principal,
    chain: chainWithoutNames(principal.chain),
    exp: now + ttlMs,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");

  return `${RUN_TOKEN_PREFIX}${payload}.${sign(payload).toString("base64url")}`;
}

function runTokenKey(): Buffer {
  const secret = requireEnv("STAGE_TICKET_SECRET");
  if (derivedKey?.secret !== secret) {
    derivedKey = {
      secret: secret,
      key: Buffer.from(hkdfSync("sha256", secret, "", HKDF_INFO, KEY_BYTES)),
    };
  }

  return derivedKey.key;
}

function sign(payload: string): Buffer {
  return createHmac("sha256", runTokenKey()).update(payload).digest();
}
