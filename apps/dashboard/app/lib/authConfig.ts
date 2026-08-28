// WorkOS redirect URI shared by proxy, sign-in, and callback so they never drift.
export const redirectUri =
  process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI ??
  "http://localhost:3000/auth/callback";

export const appOrigin = new URL(redirectUri).origin;
