/**
 * The self-hosted sign-in, shared by the dashboard that issues its session
 * token and the Convex auth config that trusts it. A self-hosted stack has one
 * user, the admin, who signs in with the stack's ADMIN_ACCOUNT_SECRET; no
 * identity provider and no internet.
 */

// Convex wants a URL-shaped issuer; it is never fetched, the key set is inline.
export const SELF_HOST_ISSUER = "https://self-host.broods.local";
export const SELF_HOST_AUDIENCE = "broods-dashboard";

/** The one user a self-hosted stack has; the session token carries these claims. */
export const SELF_HOST_ADMIN = {
  email: "admin@broods.local",
  firstName: "Admin",
  subject: "self-host-admin",
} as const;
