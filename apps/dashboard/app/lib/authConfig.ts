// WorkOS redirect URI shared by proxy, sign-in, and callback so they never drift.
export const redirectUri =
  process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI ??
  "http://localhost:3000/auth/callback";

export const appOrigin = new URL(redirectUri).origin;

/**
 * Accept only a same-origin path. Parsing against a fixed base catches every
 * open-redirect encoding ("//evil.com", "/\evil.com", tab/newline tricks) that
 * a prefix check misses. The URL parser normalizes backslashes to forward
 * slashes and strips tabs/newlines exactly like browsers do, so anything that
 * would escape the origin fails the origin check below.
 */
export function parseReturnTo(value: string | null): string | null {
  if (!value?.startsWith("/")) {
    return null;
  }
  try {
    const url = new URL(value, "http://relative-base");
    if (url.origin !== "http://relative-base") {
      return null;
    }

    return url.pathname + url.search + url.hash;
  } catch {
    return null;
  }
}
