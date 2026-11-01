const encoder = new TextEncoder();

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
