/** Runtime-persistence calls shared by the harness and account cleanup. */

import type { FunctionReturnType } from "convex/server";
import { adminMutation, adminQuery, internal } from "./client.ts";

// Exported so tests can verify each reference against the actual registered
// Convex module export as well as the exact function path sent to Convex.
export const runtimeQueries = {
  getAsyncAgentResult: internal.runtime.getAsyncAgentResult,
  getAsyncToolResult: internal.runtime.getAsyncToolResult,
  getAsyncToolToken: internal.runtime.getAsyncToolToken,
  getConversationTarget: internal.runtimeIngress.getConversationTarget,
  getHarnessSession: internal.runtime.getHarnessSession,
  getSandboxReleaseTarget: internal.runtime.getSandboxReleaseTarget,
  getSandboxReservation: internal.runtime.getSandboxReservation,
  getSandboxReservationRecord: internal.runtime.getSandboxReservationRecord,
  listAccountSandboxReservations:
    internal.runtime.listAccountSandboxReservations,
  listBuildingSandboxSnapshots: internal.runtime.listBuildingSandboxSnapshots,
  listConversationEvents: internal.runtime.listConversationEvents,
  listExpiredSandboxReservations:
    internal.runtime.listExpiredSandboxReservations,
  listOrphanedSandboxInstances: internal.runtime.listOrphanedSandboxInstances,
  listPendingAsyncToolResults: internal.runtime.listPendingAsyncToolResults,
  getIngressStatus: internal.runtimeIngress.getStatus,
  getIngressStatusByEventId: internal.runtimeIngress.getStatusByEventId,
  isCurrentIngressOwner: internal.runtimeIngress.isCurrentOwner,
} as const;

export const runtimeMutations = {
  appendConversationEvent: internal.runtime.appendConversationEvent,
  bindAsyncToolResultSandbox: internal.runtime.bindAsyncToolResultSandbox,
  claimEvent: internal.runtime.claimEvent,
  claimSandboxReservation: internal.runtime.claimSandboxReservation,
  clearConversation: internal.runtime.clearConversation,
  createAsyncAgentResult: internal.runtime.createAsyncAgentResult,
  createAsyncToolResult: internal.runtime.createAsyncToolResult,
  deferSandboxReservations: internal.runtime.deferSandboxReservations,
  deleteAccountRuntimeData: internal.runtime.deleteAccountRuntimeData,
  deleteSandboxReservation: internal.runtime.deleteSandboxReservation,
  observeAsyncToolResult: internal.runtime.observeAsyncToolResult,
  releaseClaim: internal.runtime.releaseClaim,
  saveSandboxReservation: internal.runtime.saveSandboxReservation,
  saveHarnessSession: internal.runtime.saveHarnessSession,
  updateAsyncAgentResult: internal.runtime.updateAsyncAgentResult,
  updateAsyncToolResult: internal.runtime.updateAsyncToolResult,
  acceptIngress: internal.runtimeIngress.accept,
  acquireIngressClear: internal.runtimeIngress.acquireClear,
  appendFencedConversationEvent:
    internal.runtimeIngress.appendConversationEvent,
  applyIngressSteering: internal.runtimeIngress.applySteering,
  clearFencedConversation: internal.runtimeIngress.clearConversation,
  recoverQueuedIngress: internal.runtimeIngress.recoverQueued,
  releaseIngressOwner: internal.runtimeIngress.releaseOwner,
  renewIngressOwner: internal.runtimeIngress.renewOwner,
  settleIngress: internal.runtimeIngress.settle,
  stepIngressBoundary: internal.runtimeIngress.stepBoundary,
  stopIngressOwner: internal.runtimeIngress.stopOwner,
  takeNextIngress: internal.runtimeIngress.takeNext,
} as const;

type RuntimeQueries = typeof runtimeQueries;
type RuntimeMutations = typeof runtimeMutations;

/**
 * Mutable call boundary used by focused core tests without a live deployment.
 * Mutations skip the client's process-wide FIFO queue, so concurrent runs never
 * wait on each other; a caller that needs an order awaits it.
 */
export const runtime = {
  query: function <Name extends keyof RuntimeQueries>(
    name: Name,
    args: Parameters<typeof adminQuery<RuntimeQueries[Name]>>[1],
  ): Promise<FunctionReturnType<RuntimeQueries[Name]>> {
    return adminQuery(runtimeQueries[name], args);
  },
  mutate: function <Name extends keyof RuntimeMutations>(
    name: Name,
    args: Parameters<typeof adminMutation<RuntimeMutations[Name]>>[1],
  ): Promise<FunctionReturnType<RuntimeMutations[Name]>> {
    return adminMutation(runtimeMutations[name], args, { skipQueue: true });
  },
};
