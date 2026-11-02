"use client";

import { useStore } from "@xyflow/react";
import { useCallback } from "react";

const FAN_SPACING = 20;

/**
 * Y offsets `[source, target]` among same-kind edges on one (node, handle) by either end,
 * sorted by id so an antiparallel pair shares one slot pool and stays parallel.
 */
export function useEdgeFanOffset(
  id: string,
  sourceNode: string,
  sourceHandle: string | null | undefined,
  targetNode: string,
  targetHandle: string | null | undefined,
  kind: string,
): [number, number] {
  const packed = useStore(
    useCallback(
      (state: {
        edges: Array<{
          id: string;
          source: string;
          target: string;
          sourceHandle?: string | null;
          targetHandle?: string | null;
          type?: string;
        }>;
      }) => {
        const sameKind = (edge: { type?: string }): boolean =>
          (edge.type ?? "default") === kind;

        const offsetAtHandle = (
          node: string,
          handle: string | null | undefined,
        ): number => {
          const norm = handle ?? null;
          const siblings = state.edges
            .filter(
              (edge) =>
                sameKind(edge) &&
                ((edge.source === node &&
                  (edge.sourceHandle ?? null) === norm) ||
                  (edge.target === node &&
                    (edge.targetHandle ?? null) === norm)),
            )
            .map((edge) => edge.id)
            .sort();
          if (siblings.length < 2) return 0;
          const index = siblings.indexOf(id);

          return (index - (siblings.length - 1) / 2) * FAN_SPACING;
        };

        const sourceOffset = offsetAtHandle(sourceNode, sourceHandle);
        const targetOffset = offsetAtHandle(targetNode, targetHandle);

        // A string, so useStore's equality check sees an unchanged pair as unchanged.
        return `${sourceOffset}|${targetOffset}`;
      },
      [id, sourceNode, sourceHandle, targetNode, targetHandle, kind],
    ),
  );

  const [sourceOffset, targetOffset] = packed.split("|");

  return [Number(sourceOffset), Number(targetOffset)];
}
