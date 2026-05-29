/**
 * Harness-managed skill loader tool.
 * Keep the model-facing tool schema here; prompt loading lives in harness skills.
 */

import { jsonSchema, tool, type ToolSet } from "ai";
import { logError, logInfo } from "../../_shared/log.ts";
import type { Session } from "../session.ts";

export type LoadSkillPrompt = (
  skillPath: string,
  resourcePaths?: string[],
) => Promise<{ path: string; loadedPaths: string[]; stagedPath?: string; stagedFiles: string[]; bytes: number }>;

export type PublishSkillChanges = (
  skillPath: string,
  options?: { force?: boolean },
) => Promise<{ path: string; files: Array<{ path: string; size: number }>; bytes: number }>;

export default function loadSkillTool(
  session: Session,
  loadSkillPrompt: LoadSkillPrompt,
  publishSkillChanges?: PublishSkillChanges,
  options: { publishNeedsApproval?: boolean } = {},
): ToolSet {
  const tools: ToolSet = {
    load_skill: tool({
      description: "Load detailed instructions for an enabled skill. Use the exact path from the available skills list.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Exact configured skill path, for example acct_abc/example-skill.",
          },
          resources: {
            type: "array",
            items: { type: "string" },
            description: "Optional additional resource file paths inside the skill bundle.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      } as const),
      async execute(input) {
        const skillPath = (input as { path?: unknown }).path;
        const resources = (input as { resources?: unknown }).resources;
        if (typeof skillPath !== "string") {
          throw new Error("path is required");
        }
        if (resources !== undefined && (!Array.isArray(resources) || !resources.every((item) => typeof item === "string"))) {
          throw new Error("resources must be an array of strings");
        }

        try {
          const result = await loadSkillPrompt(skillPath, resources as string[] | undefined);
          logInfo("load_skill completed", {
            accountId: session.accountId,
            agentId: session.agentId,
            eventId: session.eventId,
            skillPath,
            resources: resources ?? [],
            bytes: result.bytes,
          });
          const staged = result.stagedPath
            ? `. Skill files are staged for sandbox execution at ${result.stagedPath}.`
            : ". No workspace sandbox path is available; use this skill as read-only context.";
          return {
            type: "text",
            value: `Loaded skill ${result.path}: ${result.loadedPaths.join(", ")}${staged}`,
          };
        } catch (err) {
          logError("load_skill failed", {
            accountId: session.accountId,
            agentId: session.agentId,
            eventId: session.eventId,
            skillPath,
            resources: resources ?? [],
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      },
    }),
  };

  if (!publishSkillChanges) {
    return tools;
  }

  // Add the publish_skil_changes too when publish is enabled for agent.
  return {
    ...tools,
    publish_skill_changes: tool({
      description: "Publish validated edits from the staged workspace copy of an enabled skill back to the account skill bundle. Requires Workspace and should be used only after editing files under /.skills/<skill-name>.",
      ...(options.publishNeedsApproval !== false ? { needsApproval: true } : {}),
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Exact configured skill path, for example acct_abc/example-skill.",
          },
          force: {
            type: "boolean",
            description: "Publish even if the source skill changed after checkout. Use only when the user explicitly accepts overwriting newer source changes.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      } as const),
      async execute(input) {
        const skillPath = (input as { path?: unknown }).path;
        const force = (input as { force?: unknown }).force;
        if (typeof skillPath !== "string") {
          throw new Error("path is required");
        }
        if (force !== undefined && typeof force !== "boolean") {
          throw new Error("force must be a boolean");
        }

        try {
          const result = await publishSkillChanges(skillPath, force === undefined ? {} : { force });
          logInfo("publish_skill_changes completed", {
            accountId: session.accountId,
            agentId: session.agentId,
            eventId: session.eventId,
            skillPath,
            fileCount: result.files.length,
            bytes: result.bytes,
          });
          return {
            type: "text",
            value: `Published skill ${result.path}: ${result.files.map((file) => file.path).join(", ")}`,
          };
        } catch (err) {
          logError("publish_skill_changes failed", {
            accountId: session.accountId,
            agentId: session.agentId,
            eventId: session.eventId,
            skillPath,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      },
    }),
  };
}
