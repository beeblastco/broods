// WebCrypto only, so the same code seals in Convex and opens in core.

const ENCODER = new TextEncoder();
const HMAC_ALGORITHM = { name: "HMAC", hash: "SHA-256" };
const KEY_CONTEXT = "stage-session-ticket:";

export const STAGE_SESSION_TICKET_PREFIX = "bdts_";
// Bearer-only, so short: a removed member keeps access until older tickets expire.
export const STAGE_SESSION_TICKET_TTL_MS = 15 * 60 * 1000;

export interface StageSessionTicket {
  accountId: string;
  endpointId: string;
  projectId: string;
  projectSlug: string;
  stageId: string;
  stageSlug: string;
  // Owner/admin only: a claimed machine gets every exec frame, env secrets included.
  sandboxWrite?: true;
  expiresAt: number;
}

export async function openStageSessionTicket(
  token: string,
  secret: string,
  now = Date.now(),
): Promise<StageSessionTicket | null> {
  const ticket = parseTicket(
    await openSignedTicket(
      STAGE_SESSION_TICKET_PREFIX,
      KEY_CONTEXT,
      token,
      secret,
    ),
  );
  if (!ticket || ticket.expiresAt <= now) return null;

  return ticket;
}

export async function sealStageSessionTicket(
  ticket: StageSessionTicket,
  secret: string,
): Promise<string> {
  return await sealSignedTicket(
    STAGE_SESSION_TICKET_PREFIX,
    KEY_CONTEXT,
    ticket,
    secret,
  );
}

export async function sealSignedTicket(
  prefix: string,
  keyContext: string,
  value: object,
  secret: string,
): Promise<string> {
  const payload = bytesToBase64Url(ENCODER.encode(JSON.stringify(value)));
  const signature = await crypto.subtle.sign(
    HMAC_ALGORITHM,
    await ticketKey(keyContext, secret),
    ENCODER.encode(payload),
  );

  return `${prefix}${payload}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

// WebCrypto's verify compares the MAC in constant time.
export async function openSignedTicket(
  prefix: string,
  keyContext: string,
  token: string,
  secret: string,
): Promise<unknown> {
  if (!token.startsWith(prefix)) return null;
  const [payload, signature, ...rest] = token.slice(prefix.length).split(".");
  if (!payload || !signature || rest.length > 0) return null;

  try {
    const verified = await crypto.subtle.verify(
      HMAC_ALGORITHM,
      await ticketKey(keyContext, secret),
      base64UrlToBytes(signature),
      ENCODER.encode(payload),
    );
    if (!verified) return null;

    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload)));
  } catch {
    return null;
  }
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

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function parseTicket(decoded: unknown): StageSessionTicket | null {
  if (!decoded || typeof decoded !== "object") return null;
  const record = decoded as Record<string, unknown>;
  const {
    accountId,
    endpointId,
    projectId,
    projectSlug,
    stageId,
    stageSlug,
    sandboxWrite,
    expiresAt,
  } = record;
  if (
    typeof accountId !== "string" ||
    typeof endpointId !== "string" ||
    typeof projectId !== "string" ||
    typeof projectSlug !== "string" ||
    typeof stageId !== "string" ||
    typeof stageSlug !== "string" ||
    typeof expiresAt !== "number" ||
    !Number.isFinite(expiresAt)
  ) {
    return null;
  }

  return {
    accountId: accountId,
    endpointId: endpointId,
    projectId: projectId,
    projectSlug: projectSlug,
    stageId: stageId,
    stageSlug: stageSlug,
    ...(sandboxWrite === true ? { sandboxWrite: true } : {}),
    expiresAt: expiresAt,
  };
}

// A derived key per context: a ticket never stands in for the secret or another ticket kind.
export async function ticketKey(
  keyContext: string,
  secret: string,
): Promise<CryptoKey> {
  const material = await crypto.subtle.digest(
    "SHA-256",
    ENCODER.encode(`${keyContext}${secret}`),
  );

  return crypto.subtle.importKey("raw", material, HMAC_ALGORITHM, false, [
    "sign",
    "verify",
  ]);
}
