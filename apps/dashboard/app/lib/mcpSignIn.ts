import { MCP_ORG_CLAIM } from "@broods/convex/model/mcpSignIn";
import { getWorkOS } from "@workos-inc/authkit-nextjs";
import { NotFoundException, type User } from "@workos-inc/node";

export const MCP_SIGN_IN_PATH = "/mcp-auth/start";

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
  const workos = getWorkOS();
  try {
    await claimExternalId(user.id);
    const { redirectUri } = await workos.connect.completeOAuth2({
      externalAuthId: externalAuthId,
      user: {
        id: user.id,
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
    if (error instanceof NotFoundException) return failedPath("expired");
    const ref = crypto.randomUUID().slice(0, 8);
    console.error(`[mcp-auth] sign-in failed, ref ${ref}`, error);

    return failedPath(ref);
  }
}

export function failedPath(reason: string): string {
  return `${MCP_SIGN_IN_PATH}?failed=${encodeURIComponent(reason)}`;
}

// WorkOS completes the sign-in for the user whose external id is `id`, so point it at the
// signed-in user itself; a different id already there belongs to something else.
async function claimExternalId(userId: string): Promise<void> {
  const workos = getWorkOS();
  const { externalId } = await workos.userManagement.getUser(userId);
  if (externalId === userId) return;
  if (externalId) {
    throw new Error(
      `WorkOS user ${userId} already has external id ${externalId}`,
    );
  }
  await workos.userManagement.updateUser({
    userId: userId,
    externalId: userId,
  });
}
