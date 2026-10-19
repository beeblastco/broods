/**
 * The bearer check every platform Worker core talks to runs first. The bridge
 * and the isolate Worker import this file, so the compare is written once.
 */

const encoder = new TextEncoder();

/** True when the request's Authorization header carries exactly `apiKey`. */
export async function bearerMatches(
  request: Request,
  apiKey: string,
): Promise<boolean> {
  if (!apiKey) return false;
  const header = request.headers.get("Authorization") ?? "";
  // Hashing first makes the compare constant-time whatever the token lengths.
  const [given, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(header)),
    crypto.subtle.digest("SHA-256", encoder.encode(`Bearer ${apiKey}`)),
  ]);

  return crypto.subtle.timingSafeEqual(given, expected);
}
