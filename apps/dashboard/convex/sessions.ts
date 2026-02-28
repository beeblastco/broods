/**
 * Session helpers for conversation and execution lifecycle.
 */
import { withSystemFields } from "convex-helpers/validators";
import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { verifySessionOwnership } from "./model/ownership";
import { createSessionWithTask, fetchLatestAssistantText } from "./model/sessions";
import {
  agentConfigFields,
  messageContentPartFields,
  sessionFields,
} from "./schema";

/** Validator for session records with system fields. */
const sessionValidator = v.object(withSystemFields("sessions", sessionFields));

/** Validator for agent config records with system fields. */
const agentConfigValidator = v.object(withSystemFields("agentConfigs", agentConfigFields));

/** Validator for a create-session result containing task tracking info. */
const sessionWithTaskValidator = v.object({
  sessionId: v.id("sessions"),
  taskId: v.id("tasks"),
});

/** Validator for a session with its attached config. */
const sessionWithConfigValidator = v.object({
  session: sessionValidator,
  agentConfig: agentConfigValidator,
});

/**
 * List sessions for the authenticated user.
 * @returns Sessions sorted newest first
 */
export const list = query({
  args: {},
  returns: v.array(sessionValidator),
  handler: async (ctx) => {
    // Check authenticated user
    const user = await ctx.auth.getUserIdentity();
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_authId", (q) => q.eq("authId", user.subject))
      .order("desc")
      .collect();

    return sessions;
  },
});

/**
 * Get a session by ID for the authenticated user.
 * @param sessionId Session ID
 * @returns Session document or null if not found/unauthorized
 */
export const getById = query({
  args: {
    sessionId: v.id("sessions"),
  },
  returns: v.union(sessionValidator, v.null()),
  handler: async (ctx, args) => {
    const { sessionId } = args;

    // Check authenticated user
    const user = await ctx.auth.getUserIdentity();
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const session = await ctx.db.get(sessionId);
    if (!session || session.authId !== user.subject) {
      return null;
    }

    return session;
  },
});

/**
 * Create or update a session, append user message, and create a pending task.
 * @param authId Owner ID for the session
 * @param sessionId Optional existing session ID
 * @param configId Agent config ID
 * @param userMessage Optional user message content parts
 * @param parentSessionId Optional parent session for subagent linkage
 * @param isSubagent Optional subagent marker
 * @returns Session ID and task ID
 */
export const createInternal = internalMutation({
  args: {
    authId: sessionFields.authId,
    sessionId: v.optional(v.id("sessions")),
    configId: v.id("agentConfigs"),
    userMessage: v.optional(v.array(messageContentPartFields)),
    parentSessionId: sessionFields.parentSessionId,
    isSubagent: sessionFields.isSubagent,
  },
  returns: sessionWithTaskValidator,
  handler: async (ctx, args) => {
    return await createSessionWithTask(ctx, args);
  },
});

/**
 * Gateway session creation entrypoint for machine-to-machine requests.
 * @param authId Owner auth ID for the created/updated session
 * @param sessionId Optional existing session ID
 * @param configId Agent config ID
 * @param userMessage Optional message parts to append as user input
 * @param parentSessionId Optional parent session link
 * @param isSubagent Optional subagent marker
 * @returns Session ID and task ID
 */
export const createForGateway = internalMutation({
  args: {
    authId: sessionFields.authId,
    sessionId: v.optional(v.id("sessions")),
    configId: v.id("agentConfigs"),
    userMessage: v.optional(v.array(messageContentPartFields)),
    parentSessionId: sessionFields.parentSessionId,
    isSubagent: sessionFields.isSubagent,
  },
  returns: sessionWithTaskValidator,
  handler: async (ctx, args) => {
    return await createSessionWithTask(ctx, args);
  },
});

/**
 * Get session and associated config for internal orchestration.
 * @param sessionId Session ID
 * @returns Session plus agent config
 * @throws Error if session/config is missing
 */
export const getWithConfigInternal = internalQuery({
  args: {
    sessionId: v.id("sessions"),
  },
  returns: sessionWithConfigValidator,
  handler: async (ctx, args) => {
    const { sessionId } = args;
    const session = await ctx.db.get(sessionId);
    if (!session) {
      throw new Error("Session not found");
    }
    if (!session.configId) {
      throw new Error("Session has no configId");
    }

    const agentConfig = await ctx.db.get(session.configId);
    if (!agentConfig) {
      throw new Error("Agent config not found");
    }

    return { session: session, agentConfig: agentConfig };
  },
});

/**
 * Extract the latest assistant text for a session.
 * @param sessionId Session ID
 * @returns Last assistant text or null
 */
export const getResultInternal = internalQuery({
  args: {
    sessionId: v.id("sessions"),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const { sessionId } = args;

    return await fetchLatestAssistantText(ctx, sessionId);
  },
});

/**
 * Get the latest assistant text for a session owned by the authenticated user.
 * @param sessionId Session ID
 * @returns Last assistant text or null
 */
export const getResult = query({
  args: {
    sessionId: v.id("sessions"),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const { sessionId } = args;

    // Check authenticated user
    const user = await ctx.auth.getUserIdentity();
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    await verifySessionOwnership(ctx, sessionId, user.subject);

    return await fetchLatestAssistantText(ctx, sessionId);
  },
});

