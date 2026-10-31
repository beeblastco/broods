/**
 * Canvas node and edge shapes stored in `canvasLayouts`, shared by the schema,
 * the dashboard mutations in canvas.ts and the CLI / API canvas syncs. They
 * live here because schema.ts cannot import canvas.ts (a mutation module).
 */

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

// `data` is `v.any()` (which infers `any`); every consumer treats it as an
// unknown-valued record, so the override keeps type checking without casts.
export type CanvasNode = Omit<Infer<typeof canvasNodeValidator>, "data"> & {
  data: Record<string, unknown>;
};
