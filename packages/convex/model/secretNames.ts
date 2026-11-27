// Leaf module shared with core's log redaction: a name is secret everywhere or nowhere.

const ALWAYS_SECRET_PARTS = [
  "secret",
  "password",
  "passwd",
  "passphrase",
  "kubeconfig",
];
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
const TOKEN_COUNT_NAMES = new Set([
  "cachecreationinputtokens",
  "cachedinputtokens",
  "cachereadtokens",
  "cachewritetokens",
  "inputtokens",
  "maxoutputtokens",
  "maxtokens",
  "nocachetokens",
  "outputtokens",
  "reasoningtokens",
  "texttokens",
  "totaltokens",
]);

// Not "key" or "auth": they would match monkey and oauth.
const SECRET_WORD_ENDINGS = [
  "apikey",
  "accesskey",
  "credential",
  "credentials",
  "privatekey",
  "token",
];
const MAX_CACHED_NAMES = 4096;
const cachedNames = new Map<string, boolean>();

export function isSecretName(name: string): boolean {
  let secret = cachedNames.get(name);
  if (secret === undefined) {
    secret = judgeName(name);
    if (cachedNames.size >= MAX_CACHED_NAMES) cachedNames.clear();
    cachedNames.set(name, secret);
  }

  return secret;
}

function judgeName(name: string): boolean {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word): boolean => word.length > 0);
  const last = words.at(-1);
  if (!last || TOKEN_COUNT_NAMES.has(words.join(""))) return false;
  if (
    words.some((word): boolean =>
      ALWAYS_SECRET_PARTS.some((part): boolean => word.includes(part)),
    )
  ) {
    return true;
  }
  if (!SECRET_LAST_WORDS.has(last)) {
    return SECRET_WORD_ENDINGS.some((ending): boolean => last.endsWith(ending));
  }
  if (last !== "key" && last !== "keys") return true;
  const qualifier = words.at(-2);

  return qualifier !== undefined && !IDENTIFIER_KEY_QUALIFIERS.has(qualifier);
}
