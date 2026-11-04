import { z } from "zod/mini";

import { type ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { assertEnvVarName } from "../../model/agentConfigCodec";
import { type AuditActor } from "../../model/auditEvents";
import { parseOr } from "../../model/storedJson";
import { collectionPage, json, methodNotAllowed, writeAudit } from "./shared";
import { ClientError } from "../../model/clientError";

const ENV_VALUE_BODY = z.looseObject({
  value: z.string().check(z.minLength(1), z.maxLength(8192)),
});

export async function handleAccountEnvVarRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  actor: AuditActor,
  name?: string,
): Promise<Response> {
  if (!name) {
    if (req.method !== "GET") return methodNotAllowed(["GET"]);
    return collectionPage("env", req, {
      all: () =>
        ctx.runQuery(internal.account.envVars.list, { accountId: accountId }),
      item: (variable) => ({
        name: variable.name,
        updatedAt: new Date(variable.updatedAt).toISOString(),
      }),
      page: (options) =>
        ctx.runQuery(internal.account.envVars.listPage, {
          accountId: accountId,
          paginationOpts: options,
        }),
    });
  }
  assertEnvVarName(name);
  if (req.method === "PUT") {
    const body = parseOr(ENV_VALUE_BODY, await req.json());
    if (!body) {
      throw new ClientError(
        "env value must be a string from 1 to 8192 characters",
      );
    }
    await ctx.runMutation(internal.account.envVars.set, {
      accountId: accountId,
      name: name,
      value: body.value,
    });
    // Values never reach the audit log, only the name of what changed.
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
