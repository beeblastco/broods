// Non-global so `.test()` keeps no lastIndex state; callers clone it with `g` to iterate.
export const ACCOUNT_ENV_PLACEHOLDER_PATTERN = /\$\{([A-Z][A-Z0-9_]*)\}/;

// Anchored: a literal beside a ref (`sk_live_abc${FOO}`) still carries secret material.
export const ACCOUNT_ENV_REFS_ONLY_PATTERN = /^(?:\$\{[A-Z][A-Z0-9_]*\})+$/;

export const ACCOUNT_ENV_REF_PATTERN = /^\$\{([A-Z][A-Z0-9_]*)\}$/;

// `Bearer ${TOKEN}`: refs only after an optional scheme word, so `Bearer sk-live ${X}` fails.
export const CREDENTIAL_HEADER_VALUE_PATTERN =
  /^(?:[A-Za-z]+ )?(?:\$\{[A-Z][A-Z0-9_]*\})+$/;
