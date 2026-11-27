import { RUN_TOKEN_PREFIX } from "@broods/convex/model/principal";
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { requireEnv, WORKER_TIMEOUT_BUDGET_MS } from "./env.ts";

// Each key is HKDF-derived from STAGE_TICKET_SECRET under its own info string, so a run token
// never opens a stage ticket or the reverse.
const HKDF_INFO = "broods-run-token";
const KEY_BYTES = 32;
const TTL_MARGIN_MS = 5 * 60 * 1000;
const TTL_MAX_MS = 2 * 60 * 60 * 1000;

const RUN_TOKEN_TTL_MS = Math.min(
  WORKER_TIMEOUT_BUDGET_MS + TTL_MARGIN_MS,
  TTL_MAX_MS,
);

export interface RunTokenSubject {
  accountId: string;
  agentId: string;
}

// Signed, not encrypted: the holder can read every claim.
type RunTokenClaims = RunTokenSubject & { exp: number };

const SUBAGENT_KEY_HKDF_INFO = "broods-subagent-key";
const SUBAGENT_KEY_TAG_HEX = 32;

const derivedKeys = new Map<string, { secret: string; key: Buffer }>();

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

// Proves core minted this subagent key: a direct-API caller can copy its form, not its tag.
export function subagentKeyTag(scope: string): string {
  return createHmac("sha256", derivedKey(SUBAGENT_KEY_HKDF_INFO))
    .update(scope)
    .digest("hex")
    .slice(0, SUBAGENT_KEY_TAG_HEX);
}
