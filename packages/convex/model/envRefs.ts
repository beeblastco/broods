/**
 * `${NAME}` account env ref shape, the single home. A leaf module so core
 * and the config plane share one definition without a value import dragging
 * the whole agent-config codec into core's stricter typecheck.
 */

// Non-global so `.test()` carries no lastIndex state; global clones are built
// where iteration/replacement needs them.
export const ACCOUNT_ENV_PLACEHOLDER_PATTERN = /\$\{([A-Z][A-Z0-9_]*)\}/;

/**
 * A value made ONLY of `${NAME}` refs. Anchored on purpose: a value mixing
 * literal content with a ref (`sk_live_abc${FOO}`) still carries secret
 * material.
 */
export const ACCOUNT_ENV_REFS_ONLY_PATTERN = /^(?:\$\{[A-Z][A-Z0-9_]*\})+$/;

/**
 * A credential value with no inline secret: `${NAME}` refs only, after an
 * optional auth scheme word (`Bearer ${TOKEN}`). Anchored, so a literal beside
 * a ref (`Bearer sk-live ${X}`) does not match. Members see only these.
 */
export const CREDENTIAL_HEADER_VALUE_PATTERN =
  /^(?:[A-Za-z]+ )?(?:\$\{[A-Z][A-Z0-9_]*\})+$/;
