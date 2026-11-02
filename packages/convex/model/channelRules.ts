// No Convex imports: core re-exports these from `shared/domain/channel-record.ts`.

import { z } from "zod/mini";

import {
  nonEmptyString,
  nonEmptyStrings,
  parseInput,
  unsupportedKeys,
} from "./inputSchema";

const CHANNEL_CONFIG_KEYS = [
  "instructions",
  "agentBindings",
  "workspaces",
  "policies",
  "denyTools",
  "replyIn",
  "partition",
  "sandboxImages",
  "tagRoles",
] as const;

const CHANNEL_RECORD_UPDATE_KEYS = [
  "name",
  "description",
  "workspaceRef",
  "config",
  "status",
] as const;

export const CHANNEL_REPLY_TARGETS = ["thread", "source"] as const;

const optionalString = z.nullish(z.string());
const NAMED_WORKSPACE = z.looseObject({
  name: nonEmptyString,
  workspaceId: nonEmptyString,
});
const CHANNEL_RECORD_CONFIG = z
  .looseObject({
    instructions: optionalString,
    agentBindings: z
      .array(
        z.looseObject({
          agentId: nonEmptyString,
          isDefault: z.optional(z.boolean()),
        }),
        { error: "must be a non-empty array" },
      )
      .check(
        z.minLength(1, { error: "must be a non-empty array" }),
        z.superRefine((bindings, ctx): void => {
          if (bindings.filter((binding) => binding.isDefault).length > 1)
            ctx.addIssue({
              code: "custom",
              message: "may mark only one binding as default",
            });
        }),
      ),
    workspaces: z.optional(z.array(NAMED_WORKSPACE)),
    policies: z.optional(nonEmptyStrings),
    denyTools: z.optional(nonEmptyStrings),
    replyIn: z.optional(z.enum(CHANNEL_REPLY_TARGETS)),
    partition: z.optional(
      z.discriminatedUnion(
        "by",
        [
          z.looseObject({ by: z.literal("shared") }).check(
            z.superRefine((partition, ctx): void => {
              if (partition.alias !== undefined)
                ctx.addIssue({
                  code: "custom",
                  path: ["alias"],
                  message: "is only supported when by is conversation",
                });
            }),
          ),
          z.looseObject({
            by: z.literal("conversation"),
            alias: nonEmptyString,
          }),
        ],
        {
          error: (issue): string | undefined =>
            issue.code === "invalid_union"
              ? "must be one of: shared, conversation"
              : undefined,
        },
      ),
    ),
    sandboxImages: z.optional(nonEmptyStrings),
    tagRoles: z.optional(
      z.array(
        z.looseObject({
          roleId: nonEmptyString,
          userIds: z.optional(nonEmptyStrings),
        }),
      ),
    ),
  })
  .check(unsupportedKeys(CHANNEL_CONFIG_KEYS));
const CREATE_CHANNEL_RECORD_INPUT = z.looseObject(
  {
    platform: nonEmptyString,
    externalId: nonEmptyString,
    name: nonEmptyString,
    workspaceRef: optionalString,
    description: optionalString,
    config: z.optional(z.unknown()),
  },
  { error: "Request body must be an object" },
);
// Else a typo like `descripton` normalizes to {} and PATCH answers 200 having changed nothing.
const UPDATE_CHANNEL_RECORD_INPUT = z
  .looseObject(
    {
      name: z.optional(nonEmptyString),
      description: optionalString,
      workspaceRef: optionalString,
      config: z.optional(z.unknown()),
      status: z.optional(z.enum(["active", "deleted"])),
    },
    { error: "Request body must be an object" },
  )
  .check(unsupportedKeys(CHANNEL_RECORD_UPDATE_KEYS));

export type ChannelRecordConfig = {
  instructions?: string;
  agentBindings: Array<{ agentId: string; isDefault?: boolean }>;
  workspaces?: Array<{ name: string; workspaceId: string }>;
  policies?: string[];
  denyTools?: string[];
  replyIn?: ChannelReplyIn;
  partition?: { by: "shared" } | { by: "conversation"; alias: string };
  sandboxImages?: string[];
  tagRoles?: Array<{ roleId: string; userIds: string[] }>;
};

export type ChannelReplyIn = (typeof CHANNEL_REPLY_TARGETS)[number];

export type CreateChannelRecordInput = {
  platform: string;
  externalId: string;
  workspaceRef?: string;
  name: string;
  description?: string;
  config: ChannelRecordConfig;
};

export type UpdateChannelRecordInput = {
  name?: string;
  description?: string | null;
  workspaceRef?: string | null;
  config?: ChannelRecordConfig;
  status?: "active" | "deleted";
};

export function normalizeChannelRecordConfig(
  value: unknown,
): ChannelRecordConfig {
  const config = parseInput(CHANNEL_RECORD_CONFIG, value, "config");
  const instructions = config.instructions?.trim();
  const { policies, denyTools, replyIn, sandboxImages, partition } = config;

  return {
    ...(instructions ? { instructions: instructions } : {}),
    agentBindings: config.agentBindings.map((binding) => ({
      agentId: binding.agentId.trim(),
      ...(binding.isDefault === true ? { isDefault: true } : {}),
    })),
    ...(config.workspaces
      ? {
          workspaces: config.workspaces.map((ref) => ({
            name: ref.name.trim(),
            workspaceId: ref.workspaceId.trim(),
          })),
        }
      : {}),
    ...(policies ? { policies: policies } : {}),
    ...(denyTools ? { denyTools: denyTools } : {}),
    ...(replyIn ? { replyIn: replyIn } : {}),
    ...(partition
      ? {
          partition:
            partition.by === "shared"
              ? { by: "shared" }
              : { by: "conversation", alias: partition.alias.trim() },
        }
      : {}),
    ...(sandboxImages ? { sandboxImages: sandboxImages } : {}),
    ...(config.tagRoles
      ? {
          tagRoles: config.tagRoles.map((role) => ({
            roleId: role.roleId.trim(),
            userIds: role.userIds ?? [],
          })),
        }
      : {}),
  };
}

export function normalizeCreateChannelRecordInput(
  value: unknown,
): CreateChannelRecordInput {
  const input = parseInput(CREATE_CHANNEL_RECORD_INPUT, value, "");
  const workspaceRef = input.workspaceRef?.trim();
  const description = input.description?.trim();

  return {
    platform: input.platform.trim(),
    externalId: input.externalId.trim(),
    name: input.name.trim(),
    ...(workspaceRef ? { workspaceRef: workspaceRef } : {}),
    ...(description ? { description: description } : {}),
    config: normalizeChannelRecordConfig(input.config),
  };
}

export function normalizeUpdateChannelRecordInput(
  value: unknown,
): UpdateChannelRecordInput {
  const input = parseInput(UPDATE_CHANNEL_RECORD_INPUT, value, "");
  const patch: UpdateChannelRecordInput = {};
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.description !== undefined)
    patch.description = input.description?.trim() || null;
  if (input.workspaceRef !== undefined)
    patch.workspaceRef = input.workspaceRef?.trim() || null;
  if (input.config !== undefined)
    patch.config = normalizeChannelRecordConfig(input.config);
  if (input.status !== undefined) patch.status = input.status;

  return patch;
}
