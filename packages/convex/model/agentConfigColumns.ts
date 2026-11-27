// schema.ts imports this, so every Convex call loads it: no package but convex at runtime.
import { v, type Validator, type Value } from "convex/values";
import type { z } from "zod/mini";

import type { AGENT_CONFIG, MODEL_OUTPUT } from "./agentRules";
import { AGENT_PROVIDER_NAMES } from "./modelProviders";

// What a zod output is once Convex holds it: literals widen and a loose object is an open record.
type Stored<T> = unknown extends T
  ? Value
  : T extends string
    ? string
    : T extends number
      ? number
      : T extends boolean
        ? boolean
        : T extends null | undefined
          ? T
          : T extends readonly (infer Item)[]
            ? Stored<Item>[]
            : string extends keyof T
              ? Record<string, Stored<T[string]>>
              : { [Key in keyof T]: Stored<T[Key]> };

type Column<Schema extends z.core.$ZodType> = Validator<
  Stored<z.output<Schema>>,
  "required",
  string
>;

// The codec stores only the known branches, so the top level is closed where AGENT_CONFIG is loose.
type StoredAgentConfig = z.ZodMiniObject<
  (typeof AGENT_CONFIG)["shape"],
  z.core.$strict
>;

const OPEN = v.record(v.string(), v.any());

// Rows keep `${ENV}` placeholders until core injects env: a column checks shape, never refinements.
// Written out so no call pays for zod; agentConfigColumns.test.ts holds them to the rules.
export const agentOutputFormatColumn = OPEN as Column<typeof MODEL_OUTPUT>;
export const agentExtraConfigColumn = v.object({
  agent: v.optional(v.union(OPEN, v.null())),
  harness: v.optional(
    v.union(
      v.object({
        type: v.string(),
        permissionMode: v.optional(v.string()),
        startupTimeoutMs: v.optional(v.number()),
        webSearch: v.optional(v.boolean()),
        activeTools: v.optional(v.array(v.string())),
        inactiveTools: v.optional(v.array(v.string())),
        debug: v.optional(
          v.object({
            enabled: v.optional(v.boolean()),
            level: v.optional(v.string()),
            subsystems: v.optional(v.array(v.string())),
          }),
        ),
      }),
      v.null(),
    ),
  ),
  model: v.optional(v.union(OPEN, v.null())),
  provider: v.optional(
    v.union(
      v.object(
        Object.fromEntries(
          AGENT_PROVIDER_NAMES.map((name) => [name, v.optional(OPEN)]),
        ),
      ),
      v.null(),
    ),
  ),
  transcription: v.optional(
    v.union(
      v.object({
        provider: v.optional(v.string()),
        modelId: v.optional(v.string()),
      }),
      v.null(),
    ),
  ),
  workspaces: v.optional(v.union(v.array(OPEN), v.null())),
  sandboxes: v.optional(v.array(v.string())),
  session: v.optional(v.union(OPEN, v.null())),
  hooks: v.optional(v.union(OPEN, v.null())),
  channels: v.optional(v.union(OPEN, v.null())),
  tools: v.optional(v.union(v.record(v.string(), OPEN), v.null())),
  mcp: v.optional(v.union(v.record(v.string(), OPEN), v.null())),
  denyTools: v.optional(v.array(v.string())),
  skills: v.optional(v.union(OPEN, v.null())),
  subagent: v.optional(v.union(OPEN, v.null())),
  scheduler: v.optional(v.union(OPEN, v.null())),
  browser: v.optional(v.union(OPEN, v.null())),
  policies: v.optional(v.union(v.array(v.string()), v.null())),
  publicAccess: v.optional(v.boolean()),
  allowRunOverrides: v.optional(v.boolean()),
}) as Column<StoredAgentConfig>;
