/**
 * Skills CRUD (`/v1/skills*`): list/create on the collection,
 * get/replace/delete by name. Storage lives behind the aws.skills actions.
 */

import { type ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { type ConfigAuditActor } from "../../model/auditEvents";
import { isPlainObject } from "../../model/objects";
import { json, methodNotAllowed, writeAudit } from "./shared";

/**
 * Skills CRUD: list/create on the collection, get/replace/delete by name.
 * Mirrors core's former handleSkillRoute contract.
 */
export async function handleSkillRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  actor: ConfigAuditActor,
  name?: string,
): Promise<Response> {
  if (!name) {
    if (req.method === "GET") {
      const skills = await ctx.runAction(internal.aws.skills.list, {
        accountId: accountId,
      });

      return json({ skills: skills });
    }
    if (req.method === "POST") {
      const skill = await ctx.runAction(internal.aws.skills.createSkill, {
        accountId: accountId,
        input: await req.json(),
      });
      const skillRecord: Record<string, unknown> = isPlainObject(skill)
        ? skill
        : {};
      const skillName =
        typeof skillRecord.name === "string"
          ? skillRecord.name
          : typeof skillRecord.path === "string"
            ? skillRecord.path
            : "skill";
      await writeAudit(ctx, {
        accountId: accountId,
        actor: actor,
        action: "created",
        resource: {
          kind: "skill",
          id:
            typeof skillRecord.path === "string" ? skillRecord.path : undefined,
          name: skillName,
        },
        summary: "Skill created",
      });

      return json(skill, 201);
    }

    return methodNotAllowed(["GET", "POST"]);
  }

  if (req.method === "GET") {
    const skill = await ctx.runAction(internal.aws.skills.get, {
      accountId: accountId,
      skillName: name,
    });

    return skill ? json(skill) : json({ error: "Skill not found" }, 404);
  }
  if (req.method === "PUT") {
    const skill = await ctx.runAction(internal.aws.skills.createSkill, {
      accountId: accountId,
      input: await req.json(),
      expectedName: name,
    });
    await writeAudit(ctx, {
      accountId: accountId,
      actor: actor,
      action: "updated",
      resource: { kind: "skill", id: name, name: name },
      summary: "Skill updated",
    });

    return json(skill);
  }
  if (req.method === "DELETE") {
    const deleted = await ctx.runAction(internal.aws.skills.remove, {
      accountId: accountId,
      skillName: name,
    });
    if (deleted) {
      await writeAudit(ctx, {
        accountId: accountId,
        actor: actor,
        action: "deleted",
        resource: { kind: "skill", id: name, name: name },
        summary: "Skill deleted",
      });
    }

    return deleted
      ? json({ deleted: true })
      : json({ error: "Skill not found" }, 404);
  }

  return methodNotAllowed(["GET", "PUT", "DELETE"]);
}
