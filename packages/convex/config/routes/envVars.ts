/**
 * Account-level environment variable routes (`/v1/env*`). Values are
 * write-only: list returns names and timestamps, never plaintext.
 */

import { type ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { ACCOUNT_ENV_VAR_NAME_PATTERN } from "../../model/agentConfigCodec";
import { type ConfigAuditActor } from "../../model/auditEvents";
import { isPlainObject } from "../../model/objects";
import { json, methodNotAllowed, writeAudit } from "./shared";

/** Account-level environment variable CRUD; values remain write-only. */
export async function handleAccountEnvVarRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  actor: ConfigAuditActor,
  name?: string,
): Promise<Response> {
  if (!name) {
    if (req.method !== "GET") return methodNotAllowed(["GET"]);
    const variables: Array<{ name: string; updatedAt: number }> =
      await ctx.runQuery(internal.account.envVars.list, {
        accountId: accountId,
      });

    return json({
      env: variables.map((variable) => ({
        name: variable.name,
        updatedAt: variable.updatedAt,
      })),
    });
  }
  validateAccountEnvVarName(name);
  if (req.method === "PUT") {
    const body = await req.json();
    if (
      !isPlainObject(body) ||
      typeof body.value !== "string" ||
      body.value.length < 1 ||
      body.value.length > 8192
    ) {
      throw new Error("env value must be a string from 1 to 8192 characters");
    }
    await ctx.runMutation(internal.account.envVars.set, {
      accountId: accountId,
      name: name,
      value: body.value,
    });
    // Values never reach the audit log — only the name of what changed.
    await writeAudit(ctx, {
      accountId: accountId,
      actor: actor,
      action: "updated",
      resource: { kind: "environmentVariable", name: name },
      summary: "Account env var set",
    });

    return json({ name: name });
  }
  if (req.method === "DELETE") {
    const deleted: boolean = await ctx.runMutation(
      internal.account.envVars.remove,
      { accountId: accountId, name: name },
    );
    if (deleted) {
      await writeAudit(ctx, {
        accountId: accountId,
        actor: actor,
        action: "deleted",
        resource: { kind: "environmentVariable", name: name },
        summary: "Account env var deleted",
      });
    }

    return json({ deleted: deleted });
  }

  return methodNotAllowed(["PUT", "DELETE"]);
}

/** Validate the stable uppercase name accepted by account env-var routes and references. */
function validateAccountEnvVarName(name: string): void {
  if (!ACCOUNT_ENV_VAR_NAME_PATTERN.test(name) || name.length > 64) {
    throw new Error(
      "env name must match /^[A-Z][A-Z0-9_]*$/ and be at most 64 characters",
    );
  }
}
