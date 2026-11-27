"use client";

import { isCodeManagedEdge } from "@/app/components/canvas/edgeOwnership";
import { useStore } from "@xyflow/react";

export function useCodeManagedEdge(
  id: string,
  source: string,
  target: string,
): boolean {
  return useStore((state): boolean =>
    isCodeManagedEdge({ id: id, source: source, target: target }, (nodeId) =>
      state.nodeLookup.get(nodeId),
    ),
  );
}
