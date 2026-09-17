"use client";

import {
  isCodeManagedEdgeId,
  isCodeManagedOwner,
} from "@/app/components/canvas/edgeOwnership";
import { useStore } from "@xyflow/react";

/**
 * Whether code owns an edge: its id names a `broods/` project edge, or both
 * its ends are code-managed nodes. Such an edge shows a lock, never a trash.
 */
export function useCodeManagedEdge(
  id: string,
  source: string,
  target: string,
): boolean {
  // A boolean, so the selector stays referentially stable across store updates.
  const ownedEnds = useStore(
    (state) =>
      isCodeManagedOwner(state.nodeLookup.get(source)?.data.managedBy) &&
      isCodeManagedOwner(state.nodeLookup.get(target)?.data.managedBy),
  );

  return ownedEnds || isCodeManagedEdgeId(id);
}
