/**
 * WorkOS authentication configuration for JWT providers.
 * Read more: https://docs.convex.dev/auth/authkit/
 */

const clientId = process.env.WORKOS_CLIENT_ID;

const authConfig = {
    providers: [
        {
            type: "customJwt" as const,
            issuer: "https://api.workos.com/",
            algorithm: "RS256" as const,
            jwks: `https://api.workos.com/sso/jwks/${clientId}`,
            applicationID: clientId,
        },
        {
            type: "customJwt" as const,
            issuer: `https://api.workos.com/user_management/${clientId}`,
            algorithm: "RS256" as const,
            jwks: `https://api.workos.com/sso/jwks/${clientId}`,
        },
    ],
};

export default authConfig;
