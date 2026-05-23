/**
 * ConvexHttpClient wrapper. Reads CONVEX_URL + CONVEX_DEPLOY_KEY from env
 * and caches a singleton client per Lambda invocation. Only loaded when
 * STORAGE_PROVIDER=convex.
 *
 * Deploy-key auth: ConvexHttpClient's public `setAuth` is typed for JWTs,
 * but the underlying transport accepts a deploy key in the same header.
 * The cast keeps the call site honest.
 *
 * TODO: the convex submodule currently exposes only internalQuery /
 * internalMutation; HTTP client typings reject internal function refs.
 * The provider casts the function refs to `any` at the call site. A
 * follow-up should add public action wrappers in the submodule so the
 * types line up.
 */

import { ConvexHttpClient } from "convex/browser";
import { requireEnv } from "../../env.ts";

let cached: ConvexHttpClient | null = null;

export function getConvexClient(): ConvexHttpClient {
  if (cached) return cached;
  const url = requireEnv("CONVEX_URL");
  const deployKey = requireEnv("CONVEX_DEPLOY_KEY");
  const client = new ConvexHttpClient(url);
  client.setAuth(deployKey);
  cached = client;
  return client;
}

/** Reset the cached client. Tests only. */
export function resetConvexClientForTests(): void {
  cached = null;
}
