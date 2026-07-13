/** Webhook/event dedupe claims backed by Convex transactions. */

import { runtimeMutation } from "./convex/runtime.ts";

export interface DedupeStore {
  claim(accountId: string, eventId: string, ttlSeconds?: number): Promise<boolean>;
}
const store: DedupeStore = {
  claim(accountId, eventId, ttlSeconds = 86400) {
    return runtimeMutation("claimEvent", { accountId, key: eventId, ttlSeconds });
  },
};
export function getDedupeStore(): DedupeStore {
  return store;
}
