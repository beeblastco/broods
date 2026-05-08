/**
 * Harness-managed skill loader tool.
 * Keep model-facing skill loading here; S3 skill storage lives in _shared.
 */

import { jsonSchema, tool, type ToolSet } from "ai";
import { logError, logInfo } from "../../_shared/log.ts";
import type { Session } from "../session.ts";

export default function loadSkillTool(session: Session): ToolSet {
  return {
    load_skill: tool({
      description: "Load detailed instructions for an enabled skill. Use the exact skillPath from the available skills list.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          skillPath: {
            type: "string",
            description: "Exact configured skill path, for example acct_abc/example-skill.",
          },
          resources: {
            type: "array",
            items: { type: "string" },
            description: "Optional additional resource file paths inside the skill bundle.",
          },
        },
        required: ["skillPath"],
        additionalProperties: false,
      } as const),
      async execute(input) {
        const skillPath = (input as { skillPath?: unknown }).skillPath;
        const resources = (input as { resources?: unknown }).resources;
        if (typeof skillPath !== "string") {
          throw new Error("skillPath is required");
        }
        if (resources !== undefined && (!Array.isArray(resources) || !resources.every((item) => typeof item === "string"))) {
          throw new Error("resources must be an array of strings");
        }

        try {
          const loaded = await session.loadSkillPrompt(skillPath, resources as string[] | undefined);
          logInfo("load_skill completed", {
            accountId: session.accountId,
            agentId: session.agentId,
            eventId: session.eventId,
            skillPath,
            resources: resources ?? [],
            bytes: loaded.bytes,
          });
          return {
            type: "text",
            value: `Loaded skill ${loaded.skillPath}: ${loaded.loadedPaths.join(", ")}`,
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
