/**
 * Shared ConvexHttpClient wrapper. Reads CONVEX_URL + CONVEX_DEPLOY_KEY from env
 * and caches a singleton client in the process. It is loaded lazily when
 * storage access is first needed.
 *
 * Deploy-key auth: use `setAdminAuth`, not `setAuth`. `setAuth` is for
 * end-user JWTs; deploy keys (`prod:...|...` / `dev:...|...`) are admin
 * credentials and Convex parses them via a separate header.
 *
 * TODO: the Convex package currently exposes only internalQuery /
 * internalMutation; HTTP client typings reject internal function refs.
 * The provider casts the function refs to `any` at the call site. A
 * follow-up should add public action wrappers in the submodule so the
 * types line up.
 */

import { ConvexHttpClient } from "convex/browser";
import { requireEnv } from "../env.ts";

let cached: ConvexHttpClient | null = null;

/**
 * An admin-authenticated client for one named deployment. Separate from
 * `getConvexClient` because a process can serve more than one: the Discord
 * forwarder reads every config plane, and each has its own URL and deploy key.
 */
export function createConvexClient(
  url: string,
  deployKey: string,
): ConvexHttpClient {
  const client = new ConvexHttpClient(url);
  // setAdminAuth is marked @internal and stripped from the public typings.
  (client as unknown as { setAdminAuth(key: string): void }).setAdminAuth(
    deployKey,
  );

  return client;
}

export function getConvexClient(): ConvexHttpClient {
  if (cached) return cached;
  cached = createConvexClient(
    requireEnv("CONVEX_URL"),
    requireEnv("CONVEX_DEPLOY_KEY"),
  );

  return cached;
}

/** Reset the cached client. Tests only. */
export function resetConvexClientForTests(): void {
  cached = null;
}
