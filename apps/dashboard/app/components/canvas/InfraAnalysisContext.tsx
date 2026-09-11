"use client";

/**
 * Shares the canvas infra analysis (per-workspace effective-sandbox state and
 * per-resource shared-agent counts) from the Canvas down to individual nodes so
 * each badge reads from a single graph traversal instead of recomputing.
 */
import type { CanvasInfraAnalysis } from "@/app/lib/canvasRuntimeRefs";
import { createContext, useContext } from "react";

const EMPTY_ANALYSIS: CanvasInfraAnalysis = {
  workspaceStates: {},
  agentRefCounts: {},
  connectedToAgent: {},
};

const InfraAnalysisContext = createContext<CanvasInfraAnalysis>(EMPTY_ANALYSIS);

export const InfraAnalysisProvider = InfraAnalysisContext.Provider;

export function useInfraAnalysis(): CanvasInfraAnalysis {
  return useContext(InfraAnalysisContext);
}
