/**
 * The wire contract between core's Discord adapter and `apps/discord-forwarder`:
 * the header a forwarded gateway event authenticates with, and the transport
 * credential both sides derive from the bot token. The forwarder bundles this
 * file by relative path, so `node:crypto` (a runtime builtin, nothing bundled)
 * stays its only import. Core's adapter is `discord-channel.ts`.
 */

import { hkdfSync } from "node:crypto";

// Purpose label, HKDF-separated like the brt_ key in `run-token.ts`, so the
// credential proves only "this POST came from the forwarder": a holder cannot
// call Discord with it, and the bot token never rides the public edge.
const HKDF_INFO = "broods-discord-forwarder";
const KEY_BYTES = 32;

/** Header a forwarded gateway event authenticates with. */
export const DISCORD_GATEWAY_TOKEN_HEADER = "x-discord-gateway-token";

/** The transport credential for `botToken`: deterministic, never the token itself. */
export function discordForwarderToken(botToken: string): string {
  return Buffer.from(
    hkdfSync("sha256", botToken, "", HKDF_INFO, KEY_BYTES),
  ).toString("base64url");
}
