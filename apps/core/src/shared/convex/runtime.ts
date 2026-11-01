import type { FunctionReturnType } from "convex/server";
import { adminMutation, adminQuery, internal } from "./client.ts";

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
  listOwedAsyncAgentResults: internal.runtime.listOwedAsyncAgentResults,
  listOwedAsyncToolResults: internal.runtime.listOwedAsyncToolResults,
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
  markAsyncAgentHandback: internal.runtime.markAsyncAgentHandback,
  markAsyncToolHandback: internal.runtime.markAsyncToolHandback,
  releaseClaim: internal.runtime.releaseClaim,
  saveSandboxReservation: internal.runtime.saveSandboxReservation,
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
  saveHarnessSession: internal.runtimeIngress.saveHarnessSession,
  settleIngress: internal.runtimeIngress.settle,
  stepIngressBoundary: internal.runtimeIngress.stepBoundary,
  stopIngressOwner: internal.runtimeIngress.stopOwner,
  takeNextIngress: internal.runtimeIngress.takeNext,
} as const;

type RuntimeQueries = typeof runtimeQueries;
type RuntimeMutations = typeof runtimeMutations;

// Mutations skip the client's FIFO so runs never wait on each other; await to keep an order.
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
