import { z } from "zod/mini";
import type { StageSource } from "./stageSource";

export const stageSourceSchema: z.ZodMiniType<StageSource> = z.object({
  files: z.array(z.object({ content: z.string(), path: z.string() })),
  commitSha: z.optional(z.string().check(z.regex(/^[0-9a-f]{40}$/))),
});
