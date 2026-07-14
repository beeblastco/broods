/** Runtime-persistence calls shared by the harness and account cleanup. */

import { getConvexClient } from "./client.ts";

const internal: any = require("@broods/convex/_generated/api").internal;

// Exported so tests can pin each reference's function path to the module that
// really exports it — `internal` is an anyApi proxy, so a wrong module name
// here builds fine and only fails when production calls the missing path.
export const runtimeQueries = {
  getAsyncAgentResult: internal.runtimePersistence.getAsyncAgentResult,
  getAsyncToolGroup: internal.runtimePersistence.getAsyncToolGroup,
  getAsyncToolResult: internal.runtimePersistence.getAsyncToolResult,
  getAsyncToolToken: internal.runtimePersistence.getAsyncToolToken,
  getSandboxReservation: internal.runtimePersistence.getSandboxReservation,
  listAsyncToolResults: internal.runtimePersistence.listAsyncToolResults,
  listConversationEvents: internal.runtimePersistence.listConversationEvents,
} as const;

export const runtimeMutations = {
  acquireLease: internal.runtimePersistence.acquireLease,
  appendConversationEvent: internal.runtimePersistence.appendConversationEvent,
  claimEvent: internal.runtimePersistence.claimEvent,
  claimSandboxReservation: internal.runtimePersistence.claimSandboxReservation,
  clearConversation: internal.runtimePersistence.clearConversation,
  createAsyncAgentResult: internal.runtimePersistence.createAsyncAgentResult,
  createAsyncToolResult: internal.runtimePersistence.createAsyncToolResult,
  deleteAccountRuntimeData: internal.runtimePersistence.deleteAccountRuntimeData,
  deleteSandboxReservation: internal.runtimePersistence.deleteSandboxReservation,
  enqueueIngress: internal.runtimePersistence.enqueueIngress,
  releaseClaim: internal.runtimePersistence.releaseClaim,
  releaseLease: internal.runtimePersistence.releaseLease,
  saveSandboxReservation: internal.runtimePersistence.saveSandboxReservation,
  sealAsyncToolGroup: internal.runtimePersistence.sealAsyncToolGroup,
  takeIngress: internal.runtimePersistence.takeIngress,
  updateAsyncAgentResult: internal.runtimePersistence.updateAsyncAgentResult,
  updateAsyncToolResult: internal.runtimePersistence.updateAsyncToolResult,
} as const;

type RuntimeQueryName = keyof typeof runtimeQueries;
type RuntimeMutationName = keyof typeof runtimeMutations;

/** Mutable call boundary used by focused core tests without a live deployment. */
export const runtime = {
  query<T>(name: RuntimeQueryName, args: Record<string, unknown>): Promise<T> {
    return getConvexClient().query(runtimeQueries[name], args as any) as Promise<T>;
  },
  mutate<T>(name: RuntimeMutationName, args: Record<string, unknown>): Promise<T> {
    return getConvexClient().mutation(runtimeMutations[name], args as any) as Promise<T>;
  },
};
