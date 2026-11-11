// schema.ts imports this, so every Convex call loads it: no runtime imports.
export const STAGE_SOURCE_ORIGINS = ["cli", "apply", "github"] as const;

export type StageSourceOrigin = (typeof STAGE_SOURCE_ORIGINS)[number];
