/**
 * Account role CRUD (`/v1/roles*`) and the assume-role exchange
 * (`POST /v1/account/assume-role`). Role CRUD is account-secret only; the
 * exchange also accepts CLI tokens and stage runtime keys (the latter only
 * into roles scoped to the key's own project/stage).
 */

import { type ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { sha256Hex } from "../../model/accountSecrets";
import {
  auditDetailsJson,
  type ConfigAuditActor,
} from "../../model/auditEvents";
import { toPublicRoleResponse } from "../../model/responses";
import {
  createRoleSessionToken,
  normalizeAssumeRoleInput,
  normalizeCreateRoleInput,
  normalizeUpdateRoleInput,
} from "../../model/roleRules";
import {
  bearerToken,
  json,
  methodNotAllowed,
  parseJsonRequest,
  unauthorizedResponse,
  writeAudit,
} from "./shared";

const ACCOUNT_SECRET_TOKEN_PREFIX = "fp_acct_";
const CLI_TOKEN_PREFIX = "fp_cli_";
const DEPLOYMENT_KEY_PREFIX = "fp_agent_";

type AssumeRoleCaller = {
  accountId: Id<"accounts">;
  actor: ConfigAuditActor;
  deploymentScope?: { projectId: Id<"projects">; stageId: Id<"stages"> };
};

/**
 * Exchange a role for a short-lived fp_sts_ session token.
 * @param ctx Convex action context
 * @param req incoming HTTP request
 * @returns `{ token, expiresAt }` or an error response
 */
export async function handleAssumeRoleRoute(
  ctx: ActionCtx,
  req: Request,
): Promise<Response> {
  if (req.method !== "POST") return methodNotAllowed(["POST"]);
  const caller = await resolveAssumeRoleCaller(ctx, req);
  if (!caller) return await unauthorizedResponse(ctx, req);
  const input = normalizeAssumeRoleInput(await parseJsonRequest(req));

  const role: Doc<"accountRoles"> | null = await ctx.runQuery(
    internal.account.roles.getByRoleId,
    { accountId: caller.accountId, roleId: input.roleId },
  );
  if (!role) return json({ error: "Role not found" }, 404);
  if (role.status !== "active") return json({ error: "Role is disabled" }, 403);
  // A runtime key may only assume roles pinned to its own stage: a leaked
  // fp_agent_ must not widen past the stage it already controls.
  if (caller.deploymentScope) {
    if (
      role.projectId !== caller.deploymentScope.projectId ||
      role.stageId !== caller.deploymentScope.stageId
    ) {
      return json(
        { error: "Role is not scoped to this deployment's stage" },
        403,
      );
    }
  }

  const token = createRoleSessionToken();
  const expiresAt = Date.now() + input.ttlSeconds * 1000;
  await ctx.runMutation(internal.account.roles.createSession, {
    accountId: caller.accountId,
    roleId: role.roleId,
    tokenHash: await sha256Hex(token),
    expiresAt: expiresAt,
  });
  await writeAudit(ctx, {
    accountId: caller.accountId,
    projectId: role.projectId,
    stageId: role.stageId,
    actor: caller.actor,
    action: "role-assumed",
    resource: { kind: "role", id: role.roleId, name: role.name },
    summary: "Role session created",
    detailsJson: auditDetailsJson({ ttlSeconds: input.ttlSeconds }),
  });

  return json({ token: token, expiresAt: new Date(expiresAt).toISOString() });
}

/**
 * Account role CRUD: list/create on the collection, get/patch/delete by
 * public role id. Mirrors the policy route contract.
 * @param ctx Convex action context
 * @param req incoming HTTP request
 * @param accountId authenticated account
 * @param actor audit actor
 * @param roleId public role id when addressing one role
 * @returns HTTP response
 */
export async function handleRoleRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  actor: ConfigAuditActor,
  roleId?: string,
): Promise<Response> {
  if (!roleId) {
    if (req.method === "GET") {
      const records: Doc<"accountRoles">[] = await ctx.runQuery(
        internal.account.roles.list,
        { accountId: accountId },
      );

      return json({
        roles: records.map((record) => toPublicRoleResponse(record)),
      });
    }
    if (req.method === "POST") {
      const input = normalizeCreateRoleInput(await req.json());
      const created: Doc<"accountRoles"> = await ctx.runMutation(
        internal.account.roles.createInternal,
        {
          accountId: accountId,
          name: input.name,
          policy: input.policy,
          projectId: input.projectId,
          stageId: input.stageId,
        },
      );
      await writeAudit(ctx, {
        accountId: accountId,
        projectId: created.projectId,
        stageId: created.stageId,
        actor: actor,
        action: "created",
        resource: { kind: "role", id: created.roleId, name: created.name },
        summary: "Role created",
        detailsJson: auditDetailsJson({ roleId: created.roleId }),
      });

      return json(toPublicRoleResponse(created), 201);
    }

    return methodNotAllowed(["GET", "POST"]);
  }

  if (req.method === "GET") {
    const record: Doc<"accountRoles"> | null = await ctx.runQuery(
      internal.account.roles.getByRoleId,
      { accountId: accountId, roleId: roleId },
    );

    return record
      ? json(toPublicRoleResponse(record))
      : json({ error: "Role not found" }, 404);
  }
  if (req.method === "PATCH") {
    const existing: Doc<"accountRoles"> | null = await ctx.runQuery(
      internal.account.roles.getByRoleId,
      { accountId: accountId, roleId: roleId },
    );
    if (!existing) return json({ error: "Role not found" }, 404);
    const patch = normalizeUpdateRoleInput(await req.json());
    await ctx.runMutation(internal.account.roles.updateInternal, {
      accountId: accountId,
      roleId: roleId,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.policy !== undefined ? { policy: patch.policy } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
    });
    const updated: Doc<"accountRoles"> | null = await ctx.runQuery(
      internal.account.roles.getByRoleId,
      { accountId: accountId, roleId: roleId },
    );
    if (updated) {
      await writeAudit(ctx, {
        accountId: accountId,
        projectId: updated.projectId,
        stageId: updated.stageId,
        actor: actor,
        action: "updated",
        resource: { kind: "role", id: updated.roleId, name: updated.name },
        summary: "Role updated",
        detailsJson: auditDetailsJson({
          roleId: updated.roleId,
          changedFields: Object.keys(patch).sort(),
        }),
      });
    }

    return updated
      ? json(toPublicRoleResponse(updated))
      : json({ error: "Role not found" }, 404);
  }
  if (req.method === "DELETE") {
    const existing: Doc<"accountRoles"> | null = await ctx.runQuery(
      internal.account.roles.getByRoleId,
      { accountId: accountId, roleId: roleId },
    );
    if (!existing) return json({ error: "Role not found" }, 404);
    await ctx.runMutation(internal.account.roles.removeInternal, {
      accountId: accountId,
      roleId: roleId,
    });
    await writeAudit(ctx, {
      accountId: accountId,
      projectId: existing.projectId,
      stageId: existing.stageId,
      actor: actor,
      action: "deleted",
      resource: { kind: "role", id: existing.roleId, name: existing.name },
      summary: "Role deleted",
      detailsJson: auditDetailsJson({ roleId: existing.roleId }),
    });

    return json({ deleted: true });
  }

  return methodNotAllowed(["GET", "PATCH", "DELETE"]);
}

/**
 * Resolve the assume-role caller by token prefix: account secret, CLI login
 * token, or stage runtime key. fp_sts_ sessions may not chain into new
 * sessions, and no other credential kind is accepted.
 */
async function resolveAssumeRoleCaller(
  ctx: ActionCtx,
  req: Request,
): Promise<AssumeRoleCaller | null> {
  const token = bearerToken(req);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);

  if (token.startsWith(ACCOUNT_SECRET_TOKEN_PREFIX)) {
    const account: Doc<"accounts"> | null = await ctx.runQuery(
      internal.account.accounts.getBySecretHash,
      { secretHash: tokenHash },
    );
    if (!account || account.status !== "active") return null;

    return {
      accountId: account._id,
      actor: { kind: "apiAccountSecret", id: account._id },
    };
  }

  if (token.startsWith(CLI_TOKEN_PREFIX)) {
    const resolved: { accountId: Id<"accounts"> } | null =
      await ctx.runMutation(internal.cli.auth.resolveCliToken, {
        tokenHash: tokenHash,
      });
    if (!resolved) return null;

    return { accountId: resolved.accountId, actor: { kind: "cli" } };
  }

  if (token.startsWith(DEPLOYMENT_KEY_PREFIX)) {
    const deployment: {
      accountId: Id<"accounts">;
      projectId: Id<"projects">;
      stageId: Id<"stages">;
    } | null = await ctx.runQuery(internal.agent.deployments.getByApiKeyHash, {
      apiKeyHash: tokenHash,
    });
    if (!deployment) return null;

    return {
      accountId: deployment.accountId,
      actor: { kind: "deployKey" },
      deploymentScope: {
        projectId: deployment.projectId,
        stageId: deployment.stageId,
      },
    };
  }

  return null;
}
