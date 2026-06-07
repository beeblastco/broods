"use client";

/**
 * Shares the canvas infra analysis (per-workspace effective-sandbox state and
 * per-resource shared-agent counts) from the Canvas down to individual nodes so
 * each badge reads from a single graph traversal instead of recomputing.
 */
import type { CanvasInfraAnalysis } from "@/app/lib/canvasRuntimeRefs";
import { createContext, useContext } from "react";

const EMPTY_ANALYSIS: CanvasInfraAnalysis = { workspaceStates: {}, agentRefCounts: {} };

const InfraAnalysisContext = createContext<CanvasInfraAnalysis>(EMPTY_ANALYSIS);

/** Provider wrapping the ReactFlow canvas with the latest infra analysis. */
export const InfraAnalysisProvider = InfraAnalysisContext.Provider;

/** Read the shared canvas infra analysis from within a node. */
export function useInfraAnalysis(): CanvasInfraAnalysis {
    return useContext(InfraAnalysisContext);
}
