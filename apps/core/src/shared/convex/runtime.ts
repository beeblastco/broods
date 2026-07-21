/** Runtime-persistence calls shared by the harness and account cleanup. */

import { getConvexClient } from "./client.ts";

const internal: any = require("@broods/convex/_generated/api").internal;

// Exported so tests can verify each reference against the actual registered
// Convex module export as well as the exact function path sent to Convex.
export const runtimeQueries = {
  getAsyncAgentResult: internal.runtime.getAsyncAgentResult,
  getAsyncToolGroup: internal.runtime.getAsyncToolGroup,
  getAsyncToolResult: internal.runtime.getAsyncToolResult,
  getAsyncToolToken: internal.runtime.getAsyncToolToken,
  getSandboxReservation: internal.runtime.getSandboxReservation,
  listAsyncToolResults: internal.runtime.listAsyncToolResults,
  listConversationEvents: internal.runtime.listConversationEvents,
  getIngressStatus: internal.runtimeIngress.getStatus,
  isCurrentIngressOwner: internal.runtimeIngress.isCurrentOwner,
} as const;

export const runtimeMutations = {
  appendConversationEvent: internal.runtime.appendConversationEvent,
  claimEvent: internal.runtime.claimEvent,
  claimSandboxReservation: internal.runtime.claimSandboxReservation,
  clearConversation: internal.runtime.clearConversation,
  createAsyncAgentResult: internal.runtime.createAsyncAgentResult,
  createAsyncToolResult: internal.runtime.createAsyncToolResult,
  deleteAccountRuntimeData: internal.runtime.deleteAccountRuntimeData,
  deleteSandboxReservation: internal.runtime.deleteSandboxReservation,
  releaseClaim: internal.runtime.releaseClaim,
  saveSandboxReservation: internal.runtime.saveSandboxReservation,
  sealAsyncToolGroup: internal.runtime.sealAsyncToolGroup,
  updateAsyncAgentResult: internal.runtime.updateAsyncAgentResult,
  updateAsyncToolResult: internal.runtime.updateAsyncToolResult,
  acceptIngress: internal.runtimeIngress.accept,
  acquireIngressClear: internal.runtimeIngress.acquireClear,
  appendFencedConversationEvent:
    internal.runtimeIngress.appendConversationEvent,
  applyIngressSteering: internal.runtimeIngress.applySteering,
  clearFencedConversation: internal.runtimeIngress.clearConversation,
  releaseIngressOwner: internal.runtimeIngress.releaseOwner,
  renewIngressOwner: internal.runtimeIngress.renewOwner,
  settleIngress: internal.runtimeIngress.settle,
  stopIngressOwner: internal.runtimeIngress.stopOwner,
  takeNextIngress: internal.runtimeIngress.takeNext,
} as const;

type RuntimeQueryName = keyof typeof runtimeQueries;
type RuntimeMutationName = keyof typeof runtimeMutations;

/** Mutable call boundary used by focused core tests without a live deployment. */
export const runtime = {
  query<T>(name: RuntimeQueryName, args: Record<string, unknown>): Promise<T> {
    return getConvexClient().query(
      runtimeQueries[name],
      args as any,
    ) as Promise<T>;
  },
  mutate<T>(
    name: RuntimeMutationName,
    args: Record<string, unknown>,
  ): Promise<T> {
    return getConvexClient().mutation(
      runtimeMutations[name],
      args as any,
    ) as Promise<T>;
  },
};
