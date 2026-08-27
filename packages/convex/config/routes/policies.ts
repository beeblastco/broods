/**
 * Agent policy CRUD (`/v1/policies*`): list/create on the collection,
 * get/patch/delete by id.
 */

import { type ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import {
  auditDetailsJson,
  type ConfigAuditActor,
} from "../../model/auditEvents";
import {
  normalizeCreatePolicyInput,
  normalizeUpdatePolicyInput,
  toPublicAgentPolicyResponse,
} from "../../model/policyRules";
import { json, methodNotAllowed, writeAudit } from "./shared";

/**
 * Agent policy CRUD: list/create on the collection, get/patch/delete by id.
 * Mirrors core's former handlePolicyRoute contract.
 */
export async function handlePolicyConfigRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  actor: ConfigAuditActor,
  policyId?: string,
): Promise<Response> {
  if (!policyId) {
    if (req.method === "GET") {
      const records: Doc<"agentPolicies">[] = await ctx.runQuery(
        internal.agent.policies.list,
        { accountId: accountId },
      );

      return json({
        policies: records.map((record) => toPublicAgentPolicyResponse(record)),
      });
    }
    if (req.method === "POST") {
      const input = normalizeCreatePolicyInput(await req.json());
      const createdId: Id<"agentPolicies"> = await ctx.runMutation(
        internal.agent.policies.createInternal,
        {
          accountId: accountId,
          name: input.name,
          description: input.description,
          document: input.document,
        },
      );
      const created: Doc<"agentPolicies"> | null = await ctx.runQuery(
        internal.agent.policies.getById,
        {
          accountId: accountId,
          policyId: createdId,
        },
      );
      if (!created) throw new Error("Failed to fetch created agent policy");
      await writeAudit(ctx, {
        accountId: accountId,
        projectId: created.projectId,
        stageId: created.stageId,
        actor: actor,
        action: "created",
        resource: { kind: "policy", id: created._id, name: created.name },
        summary: "Policy created",
        detailsJson: auditDetailsJson({ policyId: created._id }),
      });

      return json(toPublicAgentPolicyResponse(created), 201);
    }

    return methodNotAllowed(["GET", "POST"]);
  }

  if (req.method === "GET") {
    const record: Doc<"agentPolicies"> | null = await ctx.runQuery(
      internal.agent.policies.getById,
      {
        accountId: accountId,
        policyId: policyId,
      },
    );

    return record
      ? json(toPublicAgentPolicyResponse(record))
      : json({ error: "Policy not found" }, 404);
  }
  if (req.method === "PATCH") {
    const existing: Doc<"agentPolicies"> | null = await ctx.runQuery(
      internal.agent.policies.getById,
      {
        accountId: accountId,
        policyId: policyId,
      },
    );
    if (!existing) return json({ error: "Policy not found" }, 404);
    const patch = normalizeUpdatePolicyInput(await req.json());
    await ctx.runMutation(internal.agent.policies.updateInternal, {
      accountId: accountId,
      policyId: policyId,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined
        ? { description: patch.description }
        : {}),
      ...(patch.document !== undefined ? { document: patch.document } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
    });
    const updated: Doc<"agentPolicies"> | null = await ctx.runQuery(
      internal.agent.policies.getById,
      {
        accountId: accountId,
        policyId: policyId,
      },
    );
    if (updated) {
      await writeAudit(ctx, {
        accountId: accountId,
        projectId: updated.projectId,
        stageId: updated.stageId,
        actor: actor,
        action: "updated",
        resource: { kind: "policy", id: updated._id, name: updated.name },
        summary: "Policy updated",
        detailsJson: auditDetailsJson({ policyId: updated._id }),
      });
    }

    return updated
      ? json(toPublicAgentPolicyResponse(updated))
      : json({ error: "Policy not found" }, 404);
  }
  if (req.method === "DELETE") {
    const existing: Doc<"agentPolicies"> | null = await ctx.runQuery(
      internal.agent.policies.getById,
      {
        accountId: accountId,
        policyId: policyId,
      },
    );
    if (!existing) return json({ error: "Policy not found" }, 404);
    await ctx.runMutation(internal.agent.policies.removeInternal, {
      accountId: accountId,
      policyId: policyId,
    });
    await writeAudit(ctx, {
      accountId: accountId,
      projectId: existing.projectId,
      stageId: existing.stageId,
      actor: actor,
      action: "deleted",
      resource: { kind: "policy", id: existing._id, name: existing.name },
      summary: "Policy deleted",
      detailsJson: auditDetailsJson({ policyId: existing._id }),
    });

    return json({ deleted: true });
  }

  return methodNotAllowed(["GET", "PATCH", "DELETE"]);
}
