/**
 * Shared gateway authentication helpers.
 */

/**
 * Compare two strings in constant time to prevent timing attacks.
 * @param a First string
 * @param b Second string
 * @returns True if equal
 */
function timingSafeEqual(a: string, b: string): boolean {
  const maxLength = Math.max(a.length, b.length);
  let result = a.length ^ b.length;
  for (let i = 0; i < maxLength; i++) {
    result |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }

  return result === 0;
}

/**
 * Extract and validate the gateway secret from an HTTP request header.
 * @param req HTTP request
 * @throws Error when header is missing or secret is invalid
 */
export function assertGatewaySecretFromHeader(req: Request): void {
  const secret = req.headers.get("X-Gateway-Secret");
  if (!secret) {
    throw new Error("Missing X-Gateway-Secret header");
  }
  assertGatewaySecret(secret);
}

/**
 * Validate the shared gateway secret for machine-to-machine API access.
 * @param gatewaySecret Secret provided by gateway service
 * @throws Error when secret is missing or invalid
 */
export function assertGatewaySecret(gatewaySecret: string): void {
  const expectedSecret = process.env.GATEWAY_SHARED_SECRET;
  if (!expectedSecret) {
    throw new Error("GATEWAY_SHARED_SECRET is not configured");
  }
  if (!timingSafeEqual(gatewaySecret, expectedSecret)) {
    throw new Error("Unauthorized gateway request");
  }
}
