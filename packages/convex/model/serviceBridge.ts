/**
 * The Convex-to-core service-auth bridge. Dashboard-facing actions reach
 * broods core (sandbox lifecycle verbs, MCP runtime verbs) with the shared
 * service token plus the account scope in X-Account-Id; core's
 * resolveBearerAuth service-token branch checks both.
 */

/** The broods account-manage base URL + service-auth secret, from the env. */
export function serviceEnv(): { url: string; secret: string } {
  const url = process.env.BROODS_ACCOUNT_MANAGE_URL;
  const secret = process.env.BROODS_SERVICE_AUTH_SECRET;
  if (!url || !secret) {
    throw new Error(
      "BROODS_ACCOUNT_MANAGE_URL or BROODS_SERVICE_AUTH_SECRET missing",
    );
  }

  return { url: url.replace(/\/+$/, ""), secret: secret };
}

/** Service-auth headers: shared bearer secret plus the account scope. */
export function serviceHeaders(accountId: string, secret: string): HeadersInit {
  return {
    Authorization: `Bearer ${secret}`,
    "X-Account-Id": accountId,
    "Content-Type": "application/json",
  };
}
