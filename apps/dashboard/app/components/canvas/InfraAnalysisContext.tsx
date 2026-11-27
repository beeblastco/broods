"use client";

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
