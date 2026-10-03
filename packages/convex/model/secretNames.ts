/**
 * The one rule for which config field, header or env names hold a secret.
 * Convex config redaction, MCP header refs, and core's log and policy
 * redaction all call it, so a name is secret everywhere or nowhere. Leaf
 * module, safe for the default Convex runtime and for core.
 */

// Words that make a name secret wherever they appear: secretAccessKey, dbPassword.
const ALWAYS_SECRET_WORDS = new Set([
  "secret",
  "password",
  "passwd",
  "passphrase",
  "kubeconfig",
]);
// Words that make a name secret when they end it: tokenSecret, x-api-key,
// refreshTokens, Proxy-Auth. As a qualifier they do not: tokenUrl, cookieDomain.
const SECRET_LAST_WORDS = new Set([
  "secret",
  "secrets",
  "password",
  "passwords",
  "credential",
  "credentials",
  "cookie",
  "cookies",
  "certificate",
  "pem",
  "authorization",
  "authentication",
  "auth",
  "bearer",
  "token",
  "tokens",
  "key",
  "keys",
  "apikey",
  "accesskey",
  "privatekey",
]);
// A key named for a row, an object or the public half of a pair, not a credential.
const IDENTIFIER_KEY_QUALIFIERS = new Set([
  "cache",
  "conversation",
  "destination",
  "embeddable",
  "event",
  "idempotency",
  "object",
  "partition",
  "preview",
  "public",
  "reservation",
  "resource",
  "scope",
  "sort",
  "source",
  "storage",
  "unscoped",
]);
// Numbers that end in "tokens".
const TOKEN_COUNT_NAMES = new Set([
  "cachedinputtokens",
  "cachewritetokens",
  "inputtokens",
  "maxoutputtokens",
  "maxtokens",
  "outputtokens",
  "reasoningtokens",
  "texttokens",
  "totaltokens",
]);

/**
 * Whether a name holds a secret. The name is split into words (camelCase,
 * "-", "_", "." and spaces) and judged by its last word, so `tokenSecret`
 * and `X-App-Key` are secret while `tokenUrl` and `inputTokens` are not.
 * @param name a config field, header or env var name
 */
export function isSecretName(name: string): boolean {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word): boolean => word.length > 0);
  const last = words.at(-1);
  if (!last || TOKEN_COUNT_NAMES.has(words.join(""))) return false;
  if (words.some((word): boolean => ALWAYS_SECRET_WORDS.has(word))) {
    return true;
  }
  if (!SECRET_LAST_WORDS.has(last)) return false;
  if (last !== "key" && last !== "keys") return true;
  const qualifier = words.at(-2);

  return qualifier !== undefined && !IDENTIFIER_KEY_QUALIFIERS.has(qualifier);
}
