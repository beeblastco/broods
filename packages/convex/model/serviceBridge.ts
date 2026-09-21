/**
 * The Convex-to-core service-auth bridge. Dashboard-facing actions reach
 * broods core (sandbox lifecycle verbs, MCP runtime verbs) with the shared
 * service token plus the account scope in X-Account-Id; core's
 * resolveBearerAuth service-token branch checks both.
 */

/**
 * The gateway stamps this on every request it proxies, after dropping any copy
 * the client sent. Internal callers reach core and the config plane directly
 * and never carry it, so the service token is refused wherever it is present.
 */
export const VIA_GATEWAY_HEADER = "x-broods-via-gateway";

export function serviceEnv(): { url: string; secret: string } {
  const url = process.env.BROODS_ACCOUNT_MANAGE_URL;
  const secret = process.env.SERVICE_AUTH_SECRET;
  if (!url || !secret) {
    throw new Error("BROODS_ACCOUNT_MANAGE_URL or SERVICE_AUTH_SECRET missing");
  }

  return { url: url.replace(/\/+$/, ""), secret: secret };
}

export function serviceHeaders(
  accountId: string,
  secret: string,
): Record<string, string> {
  return {
    Authorization: `Bearer ${secret}`,
    "X-Account-Id": accountId,
    "Content-Type": "application/json",
  };
}
