/**
 * Short-lived stage session tickets (`fp_dts_…`). The dashboard mints one for
 * any org member so logs, traces and the test chat run without handing the
 * browser the permanent `fp_agent_` runtime key; core verifies it and treats it
 * exactly like that key for the ticket's lifetime. Signed with an HMAC derived
 * from the service secret both sides already hold, on WebCrypto so the same
 * code runs in Convex and in core.
 */

const ENCODER = new TextEncoder();
const HMAC_ALGORITHM = { name: "HMAC", hash: "SHA-256" };
const KEY_CONTEXT = "stage-session-ticket:";

export const STAGE_SESSION_TICKET_PREFIX = "fp_dts_";
// Short because a ticket is bearer-only: a rotated key or a removed member
// is only fully out once every ticket minted before that has expired.
export const STAGE_SESSION_TICKET_TTL_MS = 15 * 60 * 1000;

export interface StageSessionTicket {
  accountId: string;
  endpointId: string;
  projectSlug: string;
  stageSlug: string;
  /** Unix ms after which the ticket is rejected. */
  expiresAt: number;
}

/** Verify a ticket's signature and expiry; null for anything else. */
export async function openStageSessionTicket(
  token: string,
  secret: string,
  now = Date.now(),
): Promise<StageSessionTicket | null> {
  if (!token.startsWith(STAGE_SESSION_TICKET_PREFIX)) return null;
  const [payload, signature, ...rest] = token
    .slice(STAGE_SESSION_TICKET_PREFIX.length)
    .split(".");
  if (!payload || !signature || rest.length > 0) return null;

  const key = await ticketKey(secret);
  let verified = false;
  try {
    verified = await crypto.subtle.verify(
      HMAC_ALGORITHM,
      key,
      base64UrlToBytes(signature),
      ENCODER.encode(payload),
    );
  } catch {
    return null;
  }
  if (!verified) return null;

  const ticket = parseTicket(payload);
  if (!ticket || ticket.expiresAt <= now) return null;

  return ticket;
}

export async function sealStageSessionTicket(
  ticket: StageSessionTicket,
  secret: string,
): Promise<string> {
  const payload = bytesToBase64Url(ENCODER.encode(JSON.stringify(ticket)));
  const signature = await crypto.subtle.sign(
    HMAC_ALGORITHM,
    await ticketKey(secret),
    ENCODER.encode(payload),
  );

  return `${STAGE_SESSION_TICKET_PREFIX}${payload}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function parseTicket(payload: string): StageSessionTicket | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload)));
  } catch {
    return null;
  }
  if (!decoded || typeof decoded !== "object") return null;
  const record = decoded as Record<string, unknown>;
  const { accountId, endpointId, projectSlug, stageSlug, expiresAt } = record;
  if (
    typeof accountId !== "string" ||
    typeof endpointId !== "string" ||
    typeof projectSlug !== "string" ||
    typeof stageSlug !== "string" ||
    typeof expiresAt !== "number" ||
    !Number.isFinite(expiresAt)
  ) {
    return null;
  }

  return {
    accountId: accountId,
    endpointId: endpointId,
    projectSlug: projectSlug,
    stageSlug: stageSlug,
    expiresAt: expiresAt,
  };
}

// The key is derived, not the raw service secret, so a ticket can never stand
// in for service-to-service auth even if the derivation context leaked.
async function ticketKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest(
    "SHA-256",
    ENCODER.encode(`${KEY_CONTEXT}${secret}`),
  );

  return crypto.subtle.importKey("raw", material, HMAC_ALGORITHM, false, [
    "sign",
    "verify",
  ]);
}
