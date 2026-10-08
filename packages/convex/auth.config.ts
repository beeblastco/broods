/**
 * JWT providers Convex trusts. Cloud: WorkOS AuthKit
 * (https://docs.convex.dev/auth/authkit/). Self-hosted, when
 * BROODS_SESSION_JWKS is set: the dashboard's admin-key session, verified
 * against that inline key set so nothing is fetched.
 */

import { SELF_HOST_AUDIENCE, SELF_HOST_ISSUER } from "./model/selfHostAuth";

const selfHostJwks = process.env.BROODS_SESSION_JWKS;

// The CLI refuses a deploy whose auth config reads an unset variable, so a
// self-hosted deploy must never touch WORKOS_CLIENT_ID.
const authConfig = {
  providers: selfHostJwks
    ? [
        {
          type: "customJwt" as const,
          issuer: SELF_HOST_ISSUER,
          algorithm: "ES256" as const,
          jwks: `data:text/plain;charset=utf-8;base64,${btoa(selfHostJwks)}`,
          applicationID: SELF_HOST_AUDIENCE,
        },
      ]
    : workosProviders(process.env.WORKOS_CLIENT_ID),
};

export default authConfig;

function workosProviders(clientId: string | undefined): {
  algorithm: "RS256";
  applicationID?: string;
  issuer: string;
  jwks: string;
  type: "customJwt";
}[] {
  return [
    {
      type: "customJwt",
      issuer: "https://api.workos.com/",
      algorithm: "RS256",
      jwks: `https://api.workos.com/sso/jwks/${clientId}`,
      applicationID: clientId,
    },
    {
      type: "customJwt",
      issuer: `https://api.workos.com/user_management/${clientId}`,
      algorithm: "RS256",
      jwks: `https://api.workos.com/sso/jwks/${clientId}`,
    },
  ];
}
