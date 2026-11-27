import { MCP_ORG_CLAIM } from "@broods/convex/model/mcpSignIn";
import { getWorkOS } from "@workos-inc/authkit-nextjs";
import { NotFoundException, type User } from "@workos-inc/node";

export const MCP_SIGN_IN_PATH = "/mcp-auth/start";

const REF_PATTERN = /^[0-9a-f]{8}$/;

export type McpSignInOrg = { slug: string; name: string };

/**
 * Hands an MCP sign-in back to AuthKit for `user`, with `org` as the token's org claim.
 * Returns where to send the browser: on to AuthKit, or back to this page with the failure.
 */
export async function completeMcpSignIn(
  user: User,
  externalAuthId: string,
  org: McpSignInOrg,
): Promise<string> {
  let id: string;
  try {
    id = await externalIdOf(user.id);
  } catch (error) {
    return loggedFailure(error);
  }
  try {
    const { redirectUri } = await getWorkOS().connect.completeOAuth2({
      externalAuthId: externalAuthId,
      user: {
        id: id,
        email: user.email,
        firstName: user.firstName ?? undefined,
        lastName: user.lastName ?? undefined,
      },
      userConsentOptions: [
        {
          claim: MCP_ORG_CLAIM,
          type: "enum",
          label: "Organization",
          choices: [{ value: org.slug, label: org.name }],
        },
      ],
    });

    return redirectUri;
  } catch (error) {
    // WorkOS answers 404 for an external_auth_id it no longer knows: used, expired or made up.
    return error instanceof NotFoundException
      ? failurePath("expired")
      : loggedFailure(error);
  }
}

export function failurePath(failure: string): string {
  return `${MCP_SIGN_IN_PATH}?failed=${failure}`;
}

/** A `?failed=` value this page wrote: `expired`, `not-admin` or a log ref, else `expired`. */
export function failureOf(value: string | undefined): string | null {
  if (!value) return null;

  return value === "not-admin" || REF_PATTERN.test(value) ? value : "expired";
}

export function loggedFailure(error: unknown): string {
  const ref = crypto.randomUUID().slice(0, 8);
  console.error(`[mcp-auth] sign-in failed, ref ${ref}`, error);

  return failurePath(ref);
}

// WorkOS completes the sign-in for the user whose external id it is given: reuse the one the
// user has, or point an empty one at the user itself so the sign-in cannot create a second user.
async function externalIdOf(userId: string): Promise<string> {
  const workos = getWorkOS();
  const { externalId } = await workos.userManagement.getUser(userId);
  if (externalId) return externalId;
  await workos.userManagement.updateUser({
    userId: userId,
    externalId: userId,
  });

  return userId;
}
