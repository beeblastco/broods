/**
 * Supported account model provider names.
 * Keep provider identifiers here so config validation and model resolution share one source.
 */

export const ACCOUNT_MODEL_PROVIDERS = {
  google: true,
  openai: true,
  bedrock: true,
  gateway: true,
} as const;

export type AccountModelProviderName = keyof typeof ACCOUNT_MODEL_PROVIDERS;

export function isAccountModelProviderName(value: string): value is AccountModelProviderName {
  return value in ACCOUNT_MODEL_PROVIDERS;
}

export function accountModelProviderNames(): AccountModelProviderName[] {
  return Object.keys(ACCOUNT_MODEL_PROVIDERS) as AccountModelProviderName[];
}
