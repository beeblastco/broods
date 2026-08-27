/**
 * Channel record validation and the public projection for the config plane.
 * Mirrors core's `shared/domain/channel-record.ts` contract; kept free of
 * Convex imports beyond `Doc` so the rules stay unit-testable.
 */

import type { Doc } from "../_generated/dataModel";
import { isPlainObject } from "./objects";

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

/** Where a reply lands: its own thread, or wherever the message came from. */
export const CHANNEL_REPLY_TARGETS = ["thread", "source"] as const;

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
  if (!isPlainObject(value)) {
    throw new Error("config must be an object");
  }
  const config = value as Record<string, unknown>;
  for (const key of Object.keys(config)) {
    if (
      !CHANNEL_CONFIG_KEYS.includes(key as (typeof CHANNEL_CONFIG_KEYS)[number])
    ) {
      throw new Error(`config.${key} is not supported`);
    }
  }
  const instructions = optionalString(
    config.instructions,
    "config.instructions",
  );
  const workspaces = normalizeWorkspaces(config.workspaces);
  const policies = optionalStringArray(config.policies, "config.policies");
  const denyTools = optionalStringArray(config.denyTools, "config.denyTools");
  const sandboxImages = optionalStringArray(
    config.sandboxImages,
    "config.sandboxImages",
  );
  const replyIn = normalizeReplyIn(config.replyIn);
  const partition = normalizePartition(config.partition);
  const tagRoles = normalizeTagRoles(config.tagRoles);

  return {
    ...(instructions ? { instructions: instructions } : {}),
    agentBindings: normalizeAgentBindings(config.agentBindings),
    ...(workspaces ? { workspaces: workspaces } : {}),
    ...(policies ? { policies: policies } : {}),
    ...(denyTools ? { denyTools: denyTools } : {}),
    ...(replyIn ? { replyIn: replyIn } : {}),
    ...(partition ? { partition: partition } : {}),
    ...(sandboxImages ? { sandboxImages: sandboxImages } : {}),
    ...(tagRoles ? { tagRoles: tagRoles } : {}),
  };
}

export function normalizeCreateChannelRecordInput(
  value: unknown,
): CreateChannelRecordInput {
  if (!isPlainObject(value)) throw new Error("Request body must be an object");
  const input = value as Record<string, unknown>;
  const workspaceRef = optionalString(input.workspaceRef, "workspaceRef");
  const description = optionalString(input.description, "description");

  return {
    platform: requireString(input.platform, "platform"),
    externalId: requireString(input.externalId, "externalId"),
    name: requireString(input.name, "name"),
    ...(workspaceRef ? { workspaceRef: workspaceRef } : {}),
    ...(description ? { description: description } : {}),
    config: normalizeChannelRecordConfig(input.config),
  };
}

export function normalizeUpdateChannelRecordInput(
  value: unknown,
): UpdateChannelRecordInput {
  if (!isPlainObject(value)) throw new Error("Request body must be an object");
  const input = value as Record<string, unknown>;
  // Without this a typo like `descripton` normalizes to {} and PATCH answers
  // 200 having changed nothing.
  for (const key of Object.keys(input)) {
    if (
      !CHANNEL_RECORD_UPDATE_KEYS.includes(
        key as (typeof CHANNEL_RECORD_UPDATE_KEYS)[number],
      )
    ) {
      throw new Error(`${key} is not supported`);
    }
  }
  const patch: UpdateChannelRecordInput = {};
  if (input.name !== undefined) patch.name = requireString(input.name, "name");
  if (input.description !== undefined) {
    patch.description =
      input.description === null
        ? null
        : (optionalString(input.description, "description") ?? null);
  }
  if (input.workspaceRef !== undefined) {
    patch.workspaceRef =
      input.workspaceRef === null
        ? null
        : (optionalString(input.workspaceRef, "workspaceRef") ?? null);
  }
  if (input.config !== undefined) {
    patch.config = normalizeChannelRecordConfig(input.config);
  }
  if (input.status !== undefined) {
    if (input.status !== "active" && input.status !== "deleted") {
      throw new Error("status must be one of: active, deleted");
    }
    patch.status = input.status;
  }

  return patch;
}

export function toPublicChannelRecordResponse(
  doc: Doc<"channelRecords">,
): Record<string, unknown> {
  return {
    accountId: doc.accountId,
    channelId: doc._id,
    platform: doc.platform,
    externalId: doc.externalId,
    ...(doc.workspaceRef ? { workspaceRef: doc.workspaceRef } : {}),
    name: doc.name,
    ...(doc.description ? { description: doc.description } : {}),
    config: doc.config,
    status: doc.status,
    createdAt: new Date(doc.createdAt).toISOString(),
    updatedAt: new Date(doc.updatedAt).toISOString(),
  };
}

function normalizeAgentBindings(
  value: unknown,
): ChannelRecordConfig["agentBindings"] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("config.agentBindings must be a non-empty array");
  }
  const bindings = value.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new Error(`config.agentBindings[${index}] must be an object`);
    }
    const binding = entry as Record<string, unknown>;
    if (
      binding.isDefault !== undefined &&
      typeof binding.isDefault !== "boolean"
    ) {
      throw new Error(
        `config.agentBindings[${index}].isDefault must be a boolean`,
      );
    }

    return {
      agentId: requireString(
        binding.agentId,
        `config.agentBindings[${index}].agentId`,
      ),
      ...(binding.isDefault === true ? { isDefault: true } : {}),
    };
  });
  if (bindings.filter((binding) => binding.isDefault).length > 1) {
    throw new Error(
      "config.agentBindings may mark only one binding as default",
    );
  }

  return bindings;
}

function normalizePartition(value: unknown): ChannelRecordConfig["partition"] {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new Error("config.partition must be an object");
  }
  const scope = value as Record<string, unknown>;
  if (scope.by === "shared") {
    if (scope.alias !== undefined) {
      throw new Error(
        "config.partition.alias is only supported when by is conversation",
      );
    }

    return { by: "shared" };
  }
  if (scope.by !== "conversation") {
    throw new Error("config.partition.by must be one of: shared, conversation");
  }

  return {
    by: "conversation",
    alias: requireString(scope.alias, "config.partition.alias"),
  };
}

function normalizeReplyIn(value: unknown): ChannelReplyIn | undefined {
  if (value === undefined) return undefined;
  if (!CHANNEL_REPLY_TARGETS.includes(value as ChannelReplyIn)) {
    throw new Error(
      `config.replyIn must be one of: ${CHANNEL_REPLY_TARGETS.join(", ")}`,
    );
  }

  return value as ChannelReplyIn;
}

function normalizeTagRoles(value: unknown): ChannelRecordConfig["tagRoles"] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value))
    throw new Error("config.tagRoles must be an array");

  return value.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new Error(`config.tagRoles[${index}] must be an object`);
    }
    const role = entry as Record<string, unknown>;

    return {
      roleId: requireString(role.roleId, `config.tagRoles[${index}].roleId`),
      userIds:
        optionalStringArray(
          role.userIds,
          `config.tagRoles[${index}].userIds`,
        ) ?? [],
    };
  });
}

function normalizeWorkspaces(
  value: unknown,
): ChannelRecordConfig["workspaces"] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value))
    throw new Error("config.workspaces must be an array");

  return value.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new Error(`config.workspaces[${index}] must be an object`);
    }
    const ref = entry as Record<string, unknown>;

    return {
      name: requireString(ref.name, `config.workspaces[${index}].name`),
      workspaceId: requireString(
        ref.workspaceId,
        `config.workspaces[${index}].workspaceId`,
      ),
    };
  });
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalStringArray(
  value: unknown,
  name: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some(
      (entry) => typeof entry !== "string" || entry.trim().length === 0,
    )
  ) {
    throw new Error(`${name} must be an array of non-empty strings`);
  }

  return value as string[];
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }

  return value.trim();
}
