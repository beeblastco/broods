/** Webhook/event dedupe claims backed by Convex transactions. */

import { runtimeMutation } from "./convex/runtime.ts";

export interface DedupeStore {
  claim(eventId: string, ttlSeconds?: number): Promise<boolean>;
}
const store: DedupeStore = {
  claim(eventId, ttlSeconds = 86400) {
    return runtimeMutation("claimEvent", { key: eventId, ttlSeconds });
  },
};
export function getDedupeStore(): DedupeStore {
  return store;
}
