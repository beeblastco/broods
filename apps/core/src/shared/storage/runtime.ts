/** Runtime-persistence calls shared by the harness and account cleanup. */

import { getConvexClient } from "./client.ts";

const internal: any = require("@broods/convex/_generated/api").internal;

/** Mutable call boundary used by focused core tests without a live deployment. */
export const runtimePersistence = {
  query<T>(name: string, args: Record<string, unknown>): Promise<T> {
    return getConvexClient().query(internal.runtimePersistence[name], args as any) as Promise<T>;
  },
  mutation<T>(name: string, args: Record<string, unknown>): Promise<T> {
    return getConvexClient().mutation(internal.runtimePersistence[name], args as any) as Promise<T>;
  },
};

export function runtimeQuery<T>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  return runtimePersistence.query(name, args);
}

export function runtimeMutation<T>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  return runtimePersistence.mutation(name, args);
}
