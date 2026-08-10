/**
 * Core's seam onto the shared model-provider list.
 * The list itself lives in the config plane so Convex, the dashboard and core
 * validate against one source; the AI SDK factory for each name lives in
 * `harness/provider.ts`. Nothing provider-specific belongs here.
 */

export {
  ACCOUNT_MODEL_PROVIDER_NAMES,
  isAccountModelProviderName,
  MODEL_PROVIDERS,
  type AccountModelProviderName,
} from "@broods/convex/model/modelProviders";

import { ACCOUNT_MODEL_PROVIDER_NAMES } from "@broods/convex/model/modelProviders";
import type { AccountModelProviderName } from "@broods/convex/model/modelProviders";

export function accountModelProviderNames(): AccountModelProviderName[] {
  return [...ACCOUNT_MODEL_PROVIDER_NAMES];
}
