/**
 * `${NAME}` account env ref shape — the single home. A leaf module so core
 * and the config plane share one definition without a value import dragging
 * the whole agent-config codec into core's stricter typecheck.
 */

// Non-global so `.test()` carries no lastIndex state; global clones are built
// where iteration/replacement needs them.
export const ACCOUNT_ENV_PLACEHOLDER_PATTERN = /\$\{([A-Z][A-Z0-9_]*)\}/;
