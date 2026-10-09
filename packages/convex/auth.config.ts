/**
 * JWT providers Convex trusts, picked by BROODS_AUTH_PROVIDER. Cloud: WorkOS
 * AuthKit (https://docs.convex.dev/auth/authkit/). Self-hosted: the
 * dashboard's admin-key session, verified against the inline
 * BROODS_SESSION_JWKS so nothing is fetched. The deploy refuses an auth config
 * that reads an unset variable, so each branch reads only its own
 * (tests/authConfig.test.ts).
 */

import {
  authProvider,
  SELF_HOST_ALGORITHM,
  SELF_HOST_AUDIENCE,
  SELF_HOST_ISSUER,
  selfHostJwks,
} from "./model/selfHostAuth";

const authConfig = {
  providers:
    authProvider() === "self-host"
      ? [
          {
            type: "customJwt" as const,
            issuer: SELF_HOST_ISSUER,
            algorithm: SELF_HOST_ALGORITHM,
            jwks: `data:text/plain;charset=utf-8;base64,${btoa(selfHostJwks())}`,
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
