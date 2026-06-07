"use client";

import { useStore } from "@xyflow/react";
import { useCallback } from "react";

/** Perpendicular gap between fanned-out parallel edges, in flow pixels. */
const FAN_SPACING = 20;

/**
 * Spreads edges that attach to the same handle so they don't stack on one point.
 * Each endpoint is fanned independently within the set of same-kind edges touching
 * that exact (node, handle) — via either end — ordered by id so an antiparallel
 * pair (A→B and B→A on the same handles) keeps a consistent slot and stays parallel.
 * Only fans within a `kind` since each kind has a fixed flow axis. Returns offsets
 * to apply perpendicular to flow: X for vertical (default) edges, Y for horizontal
 * (mount/subagent) edges.
 *
 * @param id this edge's id
 * @param sourceNode source node id
 * @param sourceHandle source handle id (null for the default top/bottom handle)
 * @param targetNode target node id
 * @param targetHandle target handle id (null for the default top/bottom handle)
 * @param kind edge kind to fan within (`default` · `mount` · `subagent`)
 * @returns `[sourceOffset, targetOffset]` in flow pixels, centered on zero
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
                const sameKind = (edge: { type?: string }) => (edge.type ?? "default") === kind;

                // Centered index of `id` among same-kind edges attaching to (node, handle) — counting
                // an edge whether the handle is its source or target end, so antiparallel links share
                // one slot pool and never collide.
                const offsetAtHandle = (node: string, handle: string | null | undefined) => {
                    const norm = handle ?? null;
                    const siblings = state.edges
                        .filter(
                            (edge) =>
                                sameKind(edge) &&
                                ((edge.source === node && (edge.sourceHandle ?? null) === norm) ||
                                    (edge.target === node && (edge.targetHandle ?? null) === norm)),
                        )
                        .map((edge) => edge.id)
                        .sort();
                    if (siblings.length < 2) return 0;
                    const index = siblings.indexOf(id);

                    return (index - (siblings.length - 1) / 2) * FAN_SPACING;
                };

                const sourceOffset = offsetAtHandle(sourceNode, sourceHandle);
                const targetOffset = offsetAtHandle(targetNode, targetHandle);

                return `${sourceOffset}|${targetOffset}`;
            },
            [id, sourceNode, sourceHandle, targetNode, targetHandle, kind],
        ),
    );

    const [sourceOffset, targetOffset] = packed.split("|");

    return [Number(sourceOffset), Number(targetOffset)];
}
