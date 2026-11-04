// Here, not in canvas.ts: schema.ts cannot import a mutation module.

import { type Infer, v } from "convex/values";

export const canvasEdgeValidator = v.object({
  id: v.string(),
  source: v.string(),
  target: v.string(),
  animated: v.optional(v.boolean()),
});

export const canvasNodeValidator = v.object({
  id: v.string(),
  type: v.union(
    v.literal("agent"),
    v.literal("sandbox"),
    v.literal("workspace"),
    v.literal("mcp"),
    v.literal("skill"),
  ),
  position: v.object({ x: v.number(), y: v.number() }),
  data: v.any(),
});

export type CanvasEdge = Infer<typeof canvasEdgeValidator>;

// `v.any()` infers `any`; every consumer reads `data` as an unknown-valued record.
export type CanvasNode = Omit<Infer<typeof canvasNodeValidator>, "data"> & {
  data: Record<string, unknown>;
};
