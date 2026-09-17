"use client";

import { isCodeManagedEdge } from "@/app/components/canvas/edgeOwnership";
import { useStore } from "@xyflow/react";

/** Whether code owns an edge (see `isCodeManagedEdge`): it shows a lock, never a trash. */
export function useCodeManagedEdge(
  id: string,
  source: string,
  target: string,
): boolean {
  // A boolean, so the selector stays referentially stable across store updates.
  return useStore((state): boolean =>
    isCodeManagedEdge(
      { id: id, source: source, target: target },
      (nodeId): unknown => state.nodeLookup.get(nodeId)?.data.managedBy,
    ),
  );
}
