/**
 * Account self-management (`/v1/account*`) and admin account routes
 * (`/accounts*`): metadata reads/patches and secret rotation.
 */

import { type ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Doc } from "../../_generated/dataModel";
import { createAccountSecret, sha256Hex } from "../../model/accountSecrets";
import { roleDenial, rolePrincipal } from "../../model/apiAuthorization";
import {
  auditDetailsJson,
  type ConfigAuditActor,
} from "../../model/auditEvents";
import { isPlainObject } from "../../model/objects";
import {
  auditActorForAuth,
  getAccountById,
  json,
  methodNotAllowed,
  parseJsonRequest,
  requireAdminAuth,
  requireSelfAccount,
  writeAudit,
} from "./shared";

type AccountHttpRoute =
  | { kind: "self" }
  | { kind: "selfRotate" }
  | { kind: "adminList" }
  | { kind: "adminRecord"; accountId: string }
  | { kind: "adminRotate"; accountId: string }
  | { kind: "adminUnknown" };

type AccountUpdateInput = {
  username?: string;
  description?: string | null;
};

/**
 * Handle account self-management and admin account config routes.
 * @param ctx Convex action context
 * @param req incoming HTTP request
 * @param route parsed account route
 * @returns HTTP response matching core account-management payloads
 */
export async function handleAccountRoute(
  ctx: ActionCtx,
  req: Request,
  route: AccountHttpRoute,
): Promise<Response> {
  if (route.kind === "self" || route.kind === "selfRotate") {
    const accountAuth = await requireSelfAccount(ctx, req);
    if (accountAuth instanceof Response) return accountAuth;
    const account = accountAuth.account;
    const actor = auditActorForAuth(accountAuth);

    if (accountAuth.kind === "role") {
      // Rotating the master secret from a session would be privilege
      // escalation, so no role policy can grant it.
      if (route.kind === "selfRotate") {
        return json(
          { error: "Role sessions may not rotate the account secret" },
          403,
        );
      }
      const denial = roleDenial(rolePrincipal(accountAuth.role), req.method, {
        type: "account",
        id: account._id,
      });
      if (denial) return json({ error: denial }, 403);
    }

    if (route.kind === "self") {
      if (req.method === "GET")
        return json({ account: toPublicAccount(account) });
      if (req.method === "PATCH")
        return await updateAccountResponse(
          ctx,
          account._id,
          actor,
          await parseJsonRequest(req),
        );

      return methodNotAllowed(["GET", "PATCH"]);
    }

    if (req.method === "POST")
      return await rotateAccountSecretResponse(ctx, account._id, actor);

    return methodNotAllowed(["POST"]);
  }

  const admin = await requireAdminAuth(ctx, req);
  if (admin instanceof Response) return admin;

  if (route.kind === "adminUnknown") return json({ error: "Not found" }, 404);

  if (route.kind === "adminList") {
    if (req.method !== "GET") return methodNotAllowed(["GET"]);
    const accounts: Doc<"accounts">[] = await ctx.runQuery(
      internal.account.accounts.list,
      {},
    );

    return json({
      accounts: accounts.map((account) => toPublicAccount(account)),
    });
  }

  if (route.kind === "adminRecord") {
    if (req.method === "GET") {
      const account: Doc<"accounts"> | null = await getAccountById(
        ctx,
        route.accountId,
      );

      return account
        ? json({ account: toPublicAccount(account) })
        : json({ error: "Account not found" }, 404);
    }
    if (req.method === "PATCH")
      return await updateAccountResponse(
        ctx,
        route.accountId,
        { kind: "admin" },
        await parseJsonRequest(req),
      );

    return methodNotAllowed(["GET", "PATCH"]);
  }

  if (req.method === "POST")
    return await rotateAccountSecretResponse(ctx, route.accountId, {
      kind: "admin",
    });

  return methodNotAllowed(["POST"]);
}

/**
 * Parse account config-plane pathnames, including unknown admin subpaths.
 * @param pathname request pathname
 * @returns parsed account route, or null when not account HTTP
 */
export function parseAccountRoute(pathname: string): AccountHttpRoute | null {
  if (pathname === "/v1/account") return { kind: "self" };
  if (pathname === "/v1/account/rotate-secret") return { kind: "selfRotate" };
  if (pathname === "/accounts") return { kind: "adminList" };
  if (!pathname.startsWith("/accounts/")) return null;

  const record = pathname.match(/^\/accounts\/([^/]+)$/);
  if (record?.[1])
    return { kind: "adminRecord", accountId: decodeURIComponent(record[1]) };

  const rotate = pathname.match(/^\/accounts\/([^/]+)\/rotate-secret$/);
  if (rotate?.[1])
    return { kind: "adminRotate", accountId: decodeURIComponent(rotate[1]) };

  return { kind: "adminUnknown" };
}

/**
 * Normalize account metadata patches with core's error strings.
 * @param value raw JSON body
 * @returns normalized account update input
 */
function normalizeAccountUpdateInput(value: unknown): AccountUpdateInput {
  if (!isPlainObject(value)) throw new Error("Request body must be an object");
  if ("config" in value)
    throw new Error(
      "Agent config must be updated through /v1/agents/{agentId}",
    );
  const normalized: AccountUpdateInput = {
    ...(value.username !== undefined
      ? { username: requireString(value.username, "username") }
      : {}),
    ...(value.description !== undefined
      ? {
          description:
            value.description === null
              ? null
              : optionalString(value.description, "description"),
        }
      : {}),
  };
  if (Object.keys(normalized).length === 0) {
    throw new Error("Request body must include username or description");
  }

  return normalized;
}

/**
 * Normalize an optional string field, omitting empty strings.
 * @param value raw value
 * @param name field name for error messages
 * @returns trimmed string or undefined
 */
function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Require a trimmed non-empty string.
 * @param value raw value
 * @param name field name for error messages
 * @returns trimmed string
 */
function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }

  return value.trim();
}

/**
 * Rotate an account secret hash and return the one-time plaintext secret.
 * @param ctx Convex action context
 * @param accountId account id to rotate
 * @returns rotate-secret response
 */
async function rotateAccountSecretResponse(
  ctx: ActionCtx,
  accountId: string,
  actor: ConfigAuditActor,
): Promise<Response> {
  const existing = await getAccountById(ctx, accountId);
  if (!existing) return json({ error: "Account not found" }, 404);
  const secret = createAccountSecret();
  await ctx.runMutation(internal.account.accounts.update, {
    accountId: existing._id,
    secretHash: await sha256Hex(secret),
  });
  const updated: Doc<"accounts"> | null = await ctx.runQuery(
    internal.account.accounts.getById,
    { accountId: existing._id },
  );
  if (updated) {
    await writeAudit(ctx, {
      accountId: existing._id,
      actor: actor,
      action: "secret-rotated",
      resource: { kind: "account", id: existing._id, name: updated.username },
      summary: "Account secret rotated",
    });
  }

  return updated
    ? json({ account: toPublicAccount(updated), secret: secret })
    : json({ error: "Account not found" }, 404);
}

/**
 * Project an account document to the public account response shape.
 * @param account account document
 * @returns public account record
 */
function toPublicAccount(account: Doc<"accounts">): Record<string, unknown> {
  return {
    accountId: account._id,
    username: account.username,
    ...(account.description ? { description: account.description } : {}),
    status: account.status,
    createdAt: new Date(account.createdAt).toISOString(),
    updatedAt: new Date(account.updatedAt).toISOString(),
  };
}

/**
 * Update an account and return the public response wrapper.
 * @param ctx Convex action context
 * @param accountId account id to update
 * @param input raw update body
 * @returns update response
 */
async function updateAccountResponse(
  ctx: ActionCtx,
  accountId: string,
  actor: ConfigAuditActor,
  input: unknown,
): Promise<Response> {
  const existing = await getAccountById(ctx, accountId);
  if (!existing) return json({ error: "Account not found" }, 404);
  const patch = normalizeAccountUpdateInput(input);
  await ctx.runMutation(internal.account.accounts.update, {
    accountId: existing._id,
    ...(patch.username !== undefined ? { username: patch.username } : {}),
    ...(patch.description !== undefined
      ? { description: patch.description }
      : {}),
  });
  const updated: Doc<"accounts"> | null = await ctx.runQuery(
    internal.account.accounts.getById,
    { accountId: existing._id },
  );
  if (updated) {
    await writeAudit(ctx, {
      accountId: existing._id,
      actor: actor,
      action: "updated",
      resource: { kind: "account", id: existing._id, name: updated.username },
      summary: "Account metadata updated",
      detailsJson: auditDetailsJson({
        changedFields: Object.keys(patch).sort(),
      }),
    });
  }

  return updated
    ? json({ account: toPublicAccount(updated) })
    : json({ error: "Account not found" }, 404);
}
