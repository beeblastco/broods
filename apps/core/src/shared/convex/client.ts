/**
 * Shared ConvexHttpClient wrapper. Reads CONVEX_URL + CONVEX_DEPLOY_KEY from env
 * and caches one client per process, built when storage access is first needed.
 *
 * Deploy-key auth: use `setAdminAuth`, not `setAuth`. `setAuth` is for end-user
 * JWTs; deploy keys (`prod:...|...` / `dev:...|...`) are admin credentials and
 * Convex parses them via a separate header.
 *
 * Every adapter reaches the backend's internal functions through `internal`
 * and `adminQuery` / `adminMutation` here. The HTTP client's typings accept
 * public refs only, but the deploy key may call internal ones, so these take an
 * internal ref and check the call against that function's own args and result.
 */

import { ConvexHttpClient } from "convex/browser";
import type { HttpMutationOptions } from "convex/browser";
import {
  getFunctionName,
  makeFunctionReference,
  type DefaultFunctionArgs,
  type FunctionArgs,
  type FunctionReference,
  type FunctionReturnType,
} from "convex/server";
import type { GenericId } from "convex/values";
import type { internal as InternalApi } from "@broods/convex/_generated/api";
import { requireEnv } from "../env.ts";

/**
 * The backend's internal functions, reached with require() on purpose: core
 * imports no backend module for its value. The type is the generated API,
 * which `codegen.staticApi` (packages/convex/convex.json) writes from each
 * function's args and returns validators, so it pulls no backend source into
 * this package's stricter typecheck.
 */
export const internal: typeof InternalApi =
  require("@broods/convex/_generated/api").internal;

/**
 * Args as they travel: a document id is a plain string on the wire, which the
 * function's `v.id(...)` validator checks, and core holds every id as one.
 */
type WireArgs<Args> =
  Args extends GenericId<string>
    ? string
    : Args extends readonly unknown[]
      ? { [Index in keyof Args]: WireArgs<Args[Index]> }
      : Args extends object
        ? { [Key in keyof Args]: WireArgs<Args[Key]> }
        : Args;

type AdminRef<Type extends "query" | "mutation"> = FunctionReference<
  Type,
  "internal"
>;

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

export function resetConvexClientForTests(): void {
  cached = null;
}

/** Runs internal query `ref` with the deploy key. */
export function adminQuery<Ref extends AdminRef<"query">>(
  ref: Ref,
  args: WireArgs<FunctionArgs<Ref>>,
): Promise<FunctionReturnType<Ref>> {
  return getConvexClient().query(
    makeFunctionReference<
      "query",
      DefaultFunctionArgs,
      FunctionReturnType<Ref>
    >(getFunctionName(ref)),
    args,
  );
}

/** Runs internal mutation `ref` with the deploy key. */
export function adminMutation<Ref extends AdminRef<"mutation">>(
  ref: Ref,
  args: WireArgs<FunctionArgs<Ref>>,
  options?: HttpMutationOptions,
): Promise<FunctionReturnType<Ref>> {
  return getConvexClient().mutation(
    makeFunctionReference<
      "mutation",
      DefaultFunctionArgs,
      FunctionReturnType<Ref>
    >(getFunctionName(ref)),
    args,
    options,
  );
}
