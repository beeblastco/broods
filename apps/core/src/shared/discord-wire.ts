// Shared with apps/discord-forwarder, which bundles this file by relative path:
// keep `node:crypto` its only import.

import { hkdfSync } from "node:crypto";

// HKDF-derived, so the credential cannot call Discord and the bot token never rides the edge.
const HKDF_INFO = "broods-discord-forwarder";
const KEY_BYTES = 32;

export const DISCORD_GATEWAY_TOKEN_HEADER = "x-discord-gateway-token";

export function discordForwarderToken(botToken: string): string {
  return Buffer.from(
    hkdfSync("sha256", botToken, "", HKDF_INFO, KEY_BYTES),
  ).toString("base64url");
}
