/**
 * Ownership verification helpers for all domain entities.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/**
 * Verify project ownership and return the project record.
 * @param ctx Query or mutation context
 * @param projectId Project document ID
 * @param authId User's authentication ID
 * @returns Project document
 * @throws Error if project not found or user doesn't own it
 */
export async function verifyProjectOwnership(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<"projects">,
  authId: string,
): Promise<Doc<"projects">> {
  const project = await ctx.db.get(projectId);
  if (!project) {
    throw new Error("Project not found");
  }
  if (project.authId !== authId) {
    throw new Error("Access denied");
  }

  return project;
}

/**
 * Verify agent config ownership and return the config record.
 * @param ctx Query or mutation context
 * @param agentConfigId Agent config document ID
 * @param authId User's authentication ID
 * @returns Agent config document
 * @throws Error if config not found or user doesn't own it
 */
export async function verifyAgentConfigOwnership(
  ctx: QueryCtx | MutationCtx,
  agentConfigId: Id<"agentConfigs">,
  authId: string,
): Promise<Doc<"agentConfigs">> {
  const config = await ctx.db.get(agentConfigId);
  if (!config) {
    throw new Error("Agent config not found");
  }
  if (config.authId !== authId) {
    throw new Error("Access denied");
  }

  return config;
}

/**
 * Verify session ownership and return the session record.
 * @param ctx Query or mutation context
 * @param sessionId Session document ID
 * @param authId User's authentication ID
 * @returns Session document
 * @throws Error if session not found or user doesn't own it
 */
export async function verifySessionOwnership(
  ctx: QueryCtx | MutationCtx,
  sessionId: Id<"sessions">,
  authId: string,
): Promise<Doc<"sessions">> {
  const session = await ctx.db.get(sessionId);
  if (!session) {
    throw new Error("Session not found");
  }
  if (session.authId !== authId) {
    throw new Error("Access denied");
  }

  return session;
}

/**
 * Verify environment ownership and return the environment record.
 * @param ctx Query or mutation context
 * @param environmentId Environment document ID
 * @param authId User's authentication ID
 * @returns Environment document
 * @throws Error if environment not found or user doesn't own it
 */
export async function verifyEnvironmentOwnership(
  ctx: QueryCtx | MutationCtx,
  environmentId: Id<"environments">,
  authId: string,
): Promise<Doc<"environments">> {
  const environment = await ctx.db.get(environmentId);
  if (!environment) {
    throw new Error("Environment not found");
  }
  if (environment.authId !== authId) {
    throw new Error("Access denied");
  }

  return environment;
}

/**
 * Verify deployment ownership and return the deployment record.
 * @param ctx Query or mutation context
 * @param deploymentId Deployment document ID
 * @param authId User's authentication ID
 * @returns Deployment document
 * @throws Error if deployment not found or user doesn't own it
 */
export async function verifyDeploymentOwnership(
  ctx: QueryCtx | MutationCtx,
  deploymentId: Id<"agentDeployments">,
  authId: string,
): Promise<Doc<"agentDeployments">> {
  const deployment = await ctx.db.get(deploymentId);
  if (!deployment) {
    throw new Error("Deployment not found");
  }
  if (deployment.authId !== authId) {
    throw new Error("Access denied");
  }

  return deployment;
}

/**
 * Verify tool service ownership and return the tool record.
 * @param ctx Query or mutation context
 * @param toolServiceId Tool service document ID
 * @param authId User's authentication ID
 * @returns Tool service document
 * @throws Error if tool not found or user doesn't own it
 */
export async function verifyToolServiceOwnership(
  ctx: QueryCtx | MutationCtx,
  toolServiceId: Id<"toolServices">,
  authId: string,
): Promise<Doc<"toolServices">> {
  const toolService = await ctx.db.get(toolServiceId);
  if (!toolService) {
    throw new Error("Tool service not found");
  }
  if (toolService.authId !== authId) {
    throw new Error("Access denied");
  }

  return toolService;
}
