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
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
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
