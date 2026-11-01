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

// require(), not import: core loads no backend module for its value, only the static API type.
export const internal: typeof InternalApi =
  require("@broods/convex/_generated/api").internal;

// Ids travel as plain strings, checked by the function's `v.id(...)` validator.
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

export function createConvexClient(
  url: string,
  deployKey: string,
): ConvexHttpClient {
  const client = new ConvexHttpClient(url);
  // Deploy keys need setAdminAuth, which is @internal and stripped from the public typings.
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

// The client's typings take public refs only; the deploy key may call internal ones.
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
