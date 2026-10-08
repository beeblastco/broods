/**
 * JWT providers Convex trusts. Cloud: WorkOS AuthKit
 * (https://docs.convex.dev/auth/authkit/). Self-hosted, when
 * BROODS_SESSION_JWKS is set: the dashboard's admin-key session, verified
 * against that inline key set so nothing is fetched.
 */

import {
  SELF_HOST_ALGORITHM,
  SELF_HOST_AUDIENCE,
  SELF_HOST_ISSUER,
  selfHostJwks,
} from "./model/selfHostAuth";

const jwks = selfHostJwks();

// The CLI refuses a deploy whose auth config reads an unset variable, so the
// self-hosted branch never reads WORKOS_CLIENT_ID.
const authConfig = {
  providers: jwks
    ? [
        {
          type: "customJwt" as const,
          issuer: SELF_HOST_ISSUER,
          algorithm: SELF_HOST_ALGORITHM,
          jwks: `data:text/plain;charset=utf-8;base64,${btoa(jwks)}`,
          applicationID: SELF_HOST_AUDIENCE,
        },
      ]
    : [
        {
          type: "customJwt" as const,
          issuer: "https://api.workos.com/",
          algorithm: "RS256" as const,
          jwks: `https://api.workos.com/sso/jwks/${process.env.WORKOS_CLIENT_ID}`,
          applicationID: process.env.WORKOS_CLIENT_ID,
        },
        {
          type: "customJwt" as const,
          issuer: `https://api.workos.com/user_management/${process.env.WORKOS_CLIENT_ID}`,
          algorithm: "RS256" as const,
          jwks: `https://api.workos.com/sso/jwks/${process.env.WORKOS_CLIENT_ID}`,
        },
      ],
};

export default authConfig;
