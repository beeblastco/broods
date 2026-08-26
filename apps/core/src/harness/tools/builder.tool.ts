/**
 * Builder canvas tools — the model-facing surface of the dashboard Builder.
 * Enabled only through `config.builder.enabled` (a dashboard-provisioned
 * agent). Every op re-resolves project/stage scope on the config-plane side
 * from the invoking runtime agent, so these tools can never reach beyond the
 * deployment they run in.
 */

import { jsonSchema, tool, type ToolSet } from "ai";
import type {
  BuilderAddAgentInput,
  BuilderConnectChannelInput,
  BuilderConnectNodesInput,
  BuilderUpdateNodeInput,
} from "../../shared/domain/builder-canvas.ts";
import {
  validateSkillDescription,
  validateSkillName,
} from "../../shared/skills.ts";
import { getStorage } from "../../shared/storage.ts";
import { toolError, toolText } from "./utils.ts";

export interface BuilderToolContext {
  accountId: string;
  // The runtime agent the Builder session runs as; scope anchor for every op.
  runtimeAgentId: string;
}

type ListCanvasInput = Record<string, never>;

/** Build the Builder tool group. Caller has checked `config.builder.enabled`. */
export function builderTools(context: BuilderToolContext): ToolSet {
  const storage = () => getStorage().builder;

  return {
    list_canvas: tool({
      description:
        "Shows the current canvas: every node with its id, kind and label, and every edge. Call this before editing so your changes use real node ids.",
      inputSchema: jsonSchema<ListCanvasInput>({
        type: "object",
        properties: {},
        additionalProperties: false,
      }),
      execute: async () => {
        const snapshot = await storage().canvasSnapshot(
          context.accountId,
          context.runtimeAgentId,
        );
        if (snapshot.nodes.length === 0) {
          return toolText(
            "The canvas is empty — no nodes yet. add_agent creates the first one.",
          );
        }

        const lines = snapshot.nodes.map((node) => {
          const bits = [
            `id=${node.id}`,
            node.type,
            node.label ? `"${node.label}"` : undefined,
            node.agentConfigId ? `config=${node.agentConfigId}` : undefined,
            node.resourceId ? `resource=${node.resourceId}` : undefined,
          ].filter((bit) => bit !== undefined);

          return `- ${bits.join(" ")}`;
        });
        if (snapshot.edges.length > 0) {
          lines.push("");
          lines.push("Connections:");
          for (const edge of snapshot.edges) {
            const source = snapshot.nodes.find(
              (node) => node.id === edge.source,
            );
            const target = snapshot.nodes.find(
              (node) => node.id === edge.target,
            );

            lines.push(
              `- ${source?.label ?? edge.source} → ${target?.label ?? edge.target}`,
            );
          }
        }

        return toolText(lines.join("\n"));
      },
    }),

    add_agent: tool({
      description:
        "Creates a new agent on the canvas: a named assistant with its own model settings and system prompt. Optionally wires an edge from an existing node.",
      inputSchema: jsonSchema<BuilderAddAgentInput>({
        type: "object",
        properties: {
          name: {
            type: "string",
            minLength: 1,
            description: "Short display name of the agent.",
          },
          description: {
            type: "string",
            description: "One-line description of what the agent does.",
          },
          systemPrompt: {
            type: "string",
            description:
              "The agent's system prompt: role, tone, and rules it must follow.",
          },
          modelId: {
            type: "string",
            description:
              "Optional model id override; omit to use the account default.",
          },
          connectFromNodeId: {
            type: "string",
            description:
              "Optional existing node id to draw a connection from into the new agent.",
          },
        },
        required: ["name"],
        additionalProperties: false,
      }),
      execute: async (input) => {
        try {
          const result = await storage().addAgent(
            context.accountId,
            context.runtimeAgentId,
            input,
          );

          // Full op result as JSON: detail for the model, nodeId/configId so
          // the dashboard chat rail can highlight the affected canvas node.
          return toolText(JSON.stringify(result));
        } catch (error) {
          return toolError(
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    }),

    update_node: tool({
      description:
        "Edits one existing node by id: rename it, change its description, or rewrite an agent's system prompt.",
      inputSchema: jsonSchema<BuilderUpdateNodeInput>({
        type: "object",
        properties: {
          nodeId: {
            type: "string",
            minLength: 1,
            description: "Id of the node to edit, from list_canvas.",
          },
          label: {
            type: "string",
            description: "New display name.",
          },
          description: {
            type: "string",
            description: "New one-line description.",
          },
          systemPrompt: {
            type: "string",
            description: "New system prompt (agent nodes only).",
          },
        },
        required: ["nodeId"],
        additionalProperties: false,
      }),
      execute: async (input) => {
        try {
          const result = await storage().updateNode(
            context.accountId,
            context.runtimeAgentId,
            input,
          );

          return toolText(JSON.stringify(result));
        } catch (error) {
          return toolError(
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    }),

    connect_nodes: tool({
      description:
        "Draws a data-flow connection between two existing nodes, source → target. Refuses duplicates and self-connections.",
      inputSchema: jsonSchema<BuilderConnectNodesInput>({
        type: "object",
        properties: {
          sourceNodeId: {
            type: "string",
            minLength: 1,
            description: "Node id the connection starts at.",
          },
          targetNodeId: {
            type: "string",
            minLength: 1,
            description: "Node id the connection ends at.",
          },
        },
        required: ["sourceNodeId", "targetNodeId"],
        additionalProperties: false,
      }),
      execute: async (input) => {
        try {
          const result = await storage().connectNodes(
            context.accountId,
            context.runtimeAgentId,
            input,
          );

          return toolText(JSON.stringify(result));
        } catch (error) {
          return toolError(
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    }),

    remove_node: tool({
      description:
        "Deletes one node from the canvas together with its connections and backing config. Only delete what the user explicitly asked to remove.",
      inputSchema: jsonSchema<{ nodeId: string }>({
        type: "object",
        properties: {
          nodeId: {
            type: "string",
            minLength: 1,
            description: "Id of the node to delete, from list_canvas.",
          },
        },
        required: ["nodeId"],
        additionalProperties: false,
      }),
      execute: async (input) => {
        try {
          const result = await storage().removeNode(
            context.accountId,
            context.runtimeAgentId,
            input.nodeId,
          );

          return toolText(JSON.stringify(result));
        } catch (error) {
          return toolError(
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    }),

    connect_channel: tool({
      description:
        "Connects a messaging channel (Telegram, Slack, Discord, etc.) to an agent node on the canvas. Requires the agent's node id from list_canvas and the channel credentials. Telegram needs botToken + webhookSecret; Slack needs botToken + signingSecret; Discord needs botToken + publicKey.",
      inputSchema: jsonSchema<BuilderConnectChannelInput>({
        type: "object",
        properties: {
          agentNodeId: {
            type: "string",
            minLength: 1,
            description:
              "Id of the agent node to connect the channel to, from list_canvas.",
          },
          channel: {
            type: "string",
            enum: ["telegram", "slack", "discord", "github", "pancake", "zalo"],
            description: "Channel platform to connect.",
          },
          credentials: {
            type: "object",
            description:
              "Channel credentials. Telegram: {botToken, webhookSecret}. Slack: {botToken, signingSecret}. Discord: {botToken, publicKey}.",
            additionalProperties: { type: "string" },
          },
        },
        required: ["agentNodeId", "channel", "credentials"],
        additionalProperties: false,
      }),
      execute: async (input) => {
        try {
          const result = await storage().connectChannel(
            context.accountId,
            context.runtimeAgentId,
            input,
          );

          return toolText(JSON.stringify(result));
        } catch (error) {
          return toolError(
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    }),

    draft_skill: tool({
      description:
        "Draft a skill: validates name, description, and markdown instructions against the platform's skill rules. Returns structured metadata the user can review before committing. No side effects — nothing is written to S3 or the canvas.",
      inputSchema: jsonSchema<{
        name: string;
        description: string;
        content: string;
      }>({
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "Skill slug: lowercase letters, numbers, hyphens only, max 64 chars.",
          },
          description: {
            type: "string",
            description: "One-line description of what the skill does.",
          },
          content: {
            type: "string",
            description:
              "Markdown instruction body for SKILL.md. Do not include YAML frontmatter; the platform generates it from name and description.",
          },
        },
        required: ["name", "description", "content"],
        additionalProperties: false,
      }),
      execute: async (input) => {
        const errors: string[] = [];

        try {
          validateSkillName(input.name);
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err));
        }

        try {
          validateSkillDescription(input.description);
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err));
        }

        if (input.content.trim().length === 0) {
          errors.push("Skill content must not be empty.");
        }

        if (errors.length > 0) {
          return toolText(
            JSON.stringify({
              type: "draftSkill",
              valid: false,
              name: input.name,
              description: input.description,
              content: input.content,
              skillPath: "",
              errors: errors,
              detail: `Draft has ${errors.length} validation error${errors.length === 1 ? "" : "s"}.`,
            } satisfies {
              type: "draftSkill";
              valid: false;
              name: string;
              description: string;
              content: string;
              skillPath: string;
              errors: string[];
              detail: string;
            }),
          );
        }

        const skillPath = `${context.accountId}/${input.name}`;

        return toolText(
          JSON.stringify({
            type: "draftSkill",
            valid: true,
            name: input.name,
            description: input.description,
            content: input.content,
            skillPath: skillPath,
            detail: `Draft validated — skill path will be ${skillPath}.`,
          } satisfies {
            type: "draftSkill";
            valid: true;
            name: string;
            description: string;
            content: string;
            skillPath: string;
            detail: string;
          }),
        );
      },
    }),

    test_skill: tool({
      description:
        "Validates a skill draft and returns example prompts for the user to review. The model produces actual test outputs for each prompt in its response text. Call this after draft_skill succeeds.",
      inputSchema: jsonSchema<{
        name: string;
        description: string;
        content: string;
        prompts: string[];
      }>({
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Skill slug, same as passed to draft_skill.",
          },
          description: {
            type: "string",
            description: "One-line description, same as draft_skill.",
          },
          content: {
            type: "string",
            description:
              "Markdown instruction body for SKILL.md. Do not include YAML frontmatter.",
          },
          prompts: {
            type: "array",
            items: { type: "string" },
            description:
              "Example prompts to test the skill against (2-5 recommended).",
          },
        },
        required: ["name", "description", "content", "prompts"],
        additionalProperties: false,
      }),
      execute: async (input) => {
        const errors: string[] = [];

        try {
          validateSkillName(input.name);
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err));
        }

        try {
          validateSkillDescription(input.description);
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err));
        }

        if (input.content.trim().length === 0) {
          errors.push("Skill content must not be empty.");
        }

        if (input.prompts.length === 0) {
          errors.push("At least one test prompt is required.");
        }

        const skillPath =
          errors.length === 0 ? `${context.accountId}/${input.name}` : "";

        const prompts = input.prompts.map((prompt) => ({
          prompt: prompt,
          status:
            errors.length === 0 ? ("validated" as const) : ("error" as const),
          ...(errors.length > 0 ? { error: errors[0] } : {}),
        }));

        return toolText(
          JSON.stringify({
            type: "testSkill",
            valid: errors.length === 0,
            name: input.name,
            skillPath: skillPath,
            prompts: prompts,
            detail:
              errors.length > 0
                ? `Validation failed: ${errors[0]}`
                : `${prompts.length} prompt${prompts.length === 1 ? "" : "s"} validated. Produce test outputs for each prompt above, then the user can Accept or Discard.`,
          } satisfies {
            type: "testSkill";
            valid: boolean;
            name: string;
            skillPath: string;
            prompts: Array<{
              prompt: string;
              status: "validated" | "error";
              error?: string;
            }>;
            detail: string;
          }),
        );
      },
    }),
  };
}
