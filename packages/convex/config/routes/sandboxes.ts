/**
 * Sandbox config CRUD (`/v1/sandboxes*`): stores encrypted config blobs,
 * redacts secrets on read, and tears down reserved instances on delete.
 */

import { type ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import {
  decryptAgentConfigBlob,
  encryptAgentConfigBlob,
} from "../../model/agentConfigCodec";
import {
  auditDetailsJson,
  type ConfigAuditActor,
} from "../../model/auditEvents";
import {
  normalizeCreateSandboxConfigInput,
  normalizeUpdateSandboxConfigInput,
  toPublicSandboxConfigResponse,
  type SandboxConfig,
} from "../../model/sandboxRules";
import {
  configEncryptionSecret,
  json,
  methodNotAllowed,
  terminateReservedInstances,
  writeAudit,
} from "./shared";

/**
 * Sandbox config CRUD: stores encrypted config blobs and redacts secrets on read.
 * Mirrors core's former handleSandboxRoute contract.
 */
export async function handleSandboxConfigRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  actor: ConfigAuditActor,
  sandboxId?: string,
): Promise<Response> {
  if (!sandboxId) {
    if (req.method === "GET") {
      const records: Doc<"sandboxConfigs">[] = await ctx.runQuery(
        internal.sandbox.configs.list,
        { accountId: accountId },
      );
      const sandboxes = await Promise.all(
        records.map(async (record) =>
          toPublicSandboxConfigResponse(
            record,
            await decryptSandboxConfig(record),
          ),
        ),
      );

      return json({ sandboxes: sandboxes });
    }
    if (req.method === "POST") {
      const input = normalizeCreateSandboxConfigInput(await req.json());
      const encrypted = await encryptSandboxConfig(input.config);
      const createdId: Id<"sandboxConfigs"> = await ctx.runMutation(
        internal.sandbox.configs.create,
        {
          accountId: accountId,
          name: input.name,
          description: input.description,
          encryptedConfig: encrypted.ciphertext,
          encryptionIv: encrypted.iv,
          encryptionTag: encrypted.tag,
        },
      );
      const created: Doc<"sandboxConfigs"> | null = await ctx.runQuery(
        internal.sandbox.configs.getById,
        {
          accountId: accountId,
          sandboxId: createdId,
        },
      );
      if (!created) throw new Error("Failed to fetch created sandbox config");
      await writeAudit(ctx, {
        accountId: accountId,
        projectId: created.projectId,
        stageId: created.stageId,
        actor: actor,
        action: "created",
        resource: { kind: "sandbox", id: created._id, name: created.name },
        summary: "Sandbox config created",
        detailsJson: auditDetailsJson({ sandboxId: created._id }),
      });

      return json(
        toPublicSandboxConfigResponse(
          created,
          await decryptSandboxConfig(created),
        ),
        201,
      );
    }

    return methodNotAllowed(["GET", "POST"]);
  }

  if (req.method === "GET") {
    const record: Doc<"sandboxConfigs"> | null = await ctx.runQuery(
      internal.sandbox.configs.getById,
      {
        accountId: accountId,
        sandboxId: sandboxId,
      },
    );

    return record
      ? json(
          toPublicSandboxConfigResponse(
            record,
            await decryptSandboxConfig(record),
          ),
        )
      : json({ error: "Sandbox not found" }, 404);
  }
  if (req.method === "PATCH") {
    const existing: Doc<"sandboxConfigs"> | null = await ctx.runQuery(
      internal.sandbox.configs.getById,
      {
        accountId: accountId,
        sandboxId: sandboxId,
      },
    );
    if (!existing) return json({ error: "Sandbox not found" }, 404);
    const existingConfig = await decryptSandboxConfig(existing);
    const patch = normalizeUpdateSandboxConfigInput(
      existingConfig,
      await req.json(),
    );
    const encrypted = await encryptSandboxConfig(patch.config);
    await ctx.runMutation(internal.sandbox.configs.update, {
      accountId: accountId,
      sandboxId: sandboxId,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined
        ? { description: patch.description ?? undefined }
        : {}),
      encryptedConfig: encrypted.ciphertext,
      encryptionIv: encrypted.iv,
      encryptionTag: encrypted.tag,
    });
    const updated: Doc<"sandboxConfigs"> | null = await ctx.runQuery(
      internal.sandbox.configs.getById,
      {
        accountId: accountId,
        sandboxId: sandboxId,
      },
    );
    if (updated) {
      await writeAudit(ctx, {
        accountId: accountId,
        projectId: updated.projectId,
        stageId: updated.stageId,
        actor: actor,
        action: "updated",
        resource: { kind: "sandbox", id: updated._id, name: updated.name },
        summary: "Sandbox config updated",
        detailsJson: auditDetailsJson({ sandboxId: updated._id }),
      });
    }

    return updated
      ? json(
          toPublicSandboxConfigResponse(
            updated,
            await decryptSandboxConfig(updated),
          ),
        )
      : json({ error: "Sandbox not found" }, 404);
  }
  if (req.method === "DELETE") {
    const existing: Doc<"sandboxConfigs"> | null = await ctx.runQuery(
      internal.sandbox.configs.getById,
      {
        accountId: accountId,
        sandboxId: sandboxId,
      },
    );
    if (!existing) return json({ error: "Sandbox not found" }, 404);
    await terminateReservedInstances(
      ctx,
      accountId,
      (instance) => instance.sandboxConfigId === existing._id,
    ).catch(() => undefined);
    await ctx.runMutation(internal.sandbox.configs.remove, {
      accountId: accountId,
      sandboxId: sandboxId,
    });
    await writeAudit(ctx, {
      accountId: accountId,
      projectId: existing.projectId,
      stageId: existing.stageId,
      actor: actor,
      action: "deleted",
      resource: { kind: "sandbox", id: existing._id, name: existing.name },
      summary: "Sandbox config deleted",
      detailsJson: auditDetailsJson({ sandboxId: existing._id }),
    });

    return json({ deleted: true });
  }

  return methodNotAllowed(["GET", "PATCH", "DELETE"]);
}

async function decryptSandboxConfig(
  doc: Doc<"sandboxConfigs">,
): Promise<SandboxConfig> {
  if (!doc.encryptedConfig || !doc.encryptionIv || !doc.encryptionTag) {
    return { provider: "sandbox", permissionMode: "ask" };
  }
  const decrypted = await decryptAgentConfigBlob(
    {
      ciphertext: doc.encryptedConfig,
      iv: doc.encryptionIv,
      tag: doc.encryptionTag,
    },
    configEncryptionSecret(),
  );

  return decrypted
    ? (decrypted as unknown as SandboxConfig)
    : { provider: "sandbox", permissionMode: "ask" };
}

async function encryptSandboxConfig(
  config: SandboxConfig,
): Promise<{ ciphertext: string; iv: string; tag: string }> {
  return await encryptAgentConfigBlob(
    config as unknown as Record<string, unknown>,
    configEncryptionSecret(),
  );
}
