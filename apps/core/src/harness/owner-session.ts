/**
 * Owner-session marker (ticket 21): decides whether a direct-API request runs
 * as the account owner working on their own agent. The dashboard's internal
 * test endpoint stamps `X-Broods-Owner-Session: 1` on its upstream call; that
 * marker is honored ONLY when the caller already authenticated as the account
 * (account secret or service token). The public deployment-key path never
 * consults this function, so a spoofed header from an external caller can
 * never mint an owner session — the rule lives here, in one tested seam.
 */

import type { AuthContext } from "../shared/auth.ts";

export const OWNER_SESSION_HEADER = "x-broods-owner-session";

export function directOwnerSession(
  authKind: AuthContext["kind"] | undefined,
  headers: Record<string, string>,
): boolean {
  if (authKind !== "account") return false;

  return headers[OWNER_SESSION_HEADER] === "1";
}
