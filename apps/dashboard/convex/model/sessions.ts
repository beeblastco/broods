/**
 * Shared session helpers for lifecycle and text extraction.
 */
import { type Infer } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { messageContentPartFields } from "../schema";
import { assertNoActiveTask } from "./tasks";

/**
 * Shared session/task creation flow used by internal and gateway entrypoints.
 * @param ctx Mutation context
 * @param args Session creation payload
 * @returns Session ID and task ID
 */
export async function createSessionWithTask(
  ctx: MutationCtx,
  args: {
    authId: string;
    sessionId?: Id<"sessions">;
    configId: Id<"agentConfigs">;
    userMessage?: Infer<typeof messageContentPartFields>[];
    parentSessionId?: Id<"sessions">;
    isSubagent?: boolean;
  },
): Promise<{ sessionId: Id<"sessions">; taskId: Id<"tasks"> }> {
  const { authId, configId, userMessage, parentSessionId, isSubagent } = args;

  // Resolve projectId from the agent config for session scoping.
  const agentConfig = await ctx.db.get(configId);
  const projectId = agentConfig?.projectId;

  let sessionId: Id<"sessions">;
  if (!args.sessionId) {
    const timestamp = Date.now().toString(36);
    const prefix = isSubagent ? "subagent-session" : "session";
    sessionId = await ctx.db.insert("sessions", {
      title: `${prefix}-${timestamp}`,
      authId: authId,
      configId: configId,
      projectId: projectId,
      parentSessionId: parentSessionId,
      isSubagent: isSubagent,
      updatedAt: Date.now(),
    });
  } else {
    sessionId = args.sessionId;

    const existingSession = await ctx.db.get(sessionId);
    if (!existingSession || existingSession.authId !== authId) {
      throw new Error("Session not found or access denied");
    }

    await ctx.db.patch(sessionId, {
      configId: configId,
      updatedAt: Date.now(),
    });
  }

  if (userMessage && userMessage.length > 0) {
    await ctx.db.insert("messages", {
      sessionId: sessionId,
      role: "user",
      content: userMessage,
      updatedAt: Date.now(),
    });
  }

  await assertNoActiveTask(ctx, sessionId);

  const taskId = await ctx.db.insert("tasks", {
    type: parentSessionId ? "subagent" : "agent",
    sessionId: sessionId,
    parentSessionId: parentSessionId,
    status: "pending",
  });

  return { sessionId: sessionId, taskId: taskId };
}

/**
 * Fetch the latest assistant text for a session directly from the database.
 * @param ctx Query context
 * @param sessionId Session ID
 * @returns Last assistant text or null
 */
export async function fetchLatestAssistantText(
  ctx: QueryCtx,
  sessionId: Id<"sessions">,
): Promise<string | null> {
  const message = await ctx.db
    .query("messages")
    .withIndex("by_sessionId_and_role", (q) =>
      q.eq("sessionId", sessionId).eq("role", "assistant"),
    )
    .order("desc")
    .first();

  return message ? extractTextFromContent(message.content) : null;
}

/**
 * Convert stored message content into plain text.
 * @param content Message content field
 * @returns Extracted text or null if none is available
 */
export function extractTextFromContent(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const textParts = content
      .filter(
        (part): part is { type: "text"; text: string } =>
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          "text" in part &&
          (part as { type: string }).type === "text" &&
          typeof (part as { text: unknown }).text === "string",
      )
      .map((part) => part.text);

    if (textParts.length === 0) {
      return null;
    }

    return textParts.join("\n");
  }

  return null;
}
