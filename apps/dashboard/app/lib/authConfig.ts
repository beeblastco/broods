export const redirectUri =
  process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI ??
  "http://localhost:3000/auth/callback";

export const appOrigin = new URL(redirectUri).origin;

// Not a prefix check: the URL parser folds "//x", "/\x" and tab tricks the way browsers do.
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
