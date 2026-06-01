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

export default function loadSkillTool(
  session: Session,
  loadSkillPrompt: LoadSkillPrompt,
): ToolSet {
  return {
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
}
