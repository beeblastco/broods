/** Convex auth config for Shoo custom JWT provider. */
const authConfig = {
  providers: [
    {
      type: "customJwt" as const,
      issuer: "https://shoo.dev",
      jwks: "https://shoo.dev/.well-known/jwks.json",
      algorithm: "ES256" as const,
    },
  ],
};

export default authConfig;
