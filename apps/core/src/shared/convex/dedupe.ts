/** Webhook/event dedupe claims backed by Convex transactions. */

import { runtime } from "./runtime.ts";

export interface DedupeStore {
  claim(
    accountId: string,
    eventId: string,
    ttlSeconds?: number,
  ): Promise<boolean>;
}
const store: DedupeStore = {
  claim: function(accountId, eventId, ttlSeconds = 86400) {
    return runtime.mutate("claimEvent", {
      accountId: accountId,
      key: eventId,
      ttlSeconds: ttlSeconds,
    });
  },
};
export function getDedupeStore(): DedupeStore {
  return store;
}
