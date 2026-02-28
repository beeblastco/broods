/**
 * Gateway-facing tool approval helpers.
 */
import { withSystemFields } from "convex-helpers/validators";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./_generated/server";
import {
  approvalStatusEnum,
  approvalTriggerEnum,
  toolApprovalFields,
} from "./schema";

/** Validator for tool approval records with system fields. */
const toolApprovalValidator = v.object(withSystemFields("toolApprovals", toolApprovalFields));

/** Validator for gateway approval decisions. */
const approvalDecisionValidator = v.object({
  approvalDocId: v.id("toolApprovals"),
  approvalId: v.string(),
  toolName: v.string(),
  toolInput: v.any(),
  status: approvalStatusEnum,
  reason: v.optional(v.string()),
});

/**
 * List pending approvals for one session.
 * @param sessionId Session ID
 * @returns Pending approval documents
 */
export const listPendingForGateway = internalQuery({
  args: {
    sessionId: v.id("sessions"),
  },
  returns: v.array(toolApprovalValidator),
  handler: async (ctx, args) => {
    const { sessionId } = args;

    return await ctx.db
      .query("toolApprovals")
      .withIndex("by_sessionId_and_status", (q) =>
        q.eq("sessionId", sessionId).eq("status", "pending"),
      )
      .collect();
  },
});

/**
 * Create an approval request for a tool/subagent step.
 * @param sessionId Session ID
 * @param approvalId Stable approval identifier
 * @param toolCallId Tool call identifier
 * @param toolName Tool name
 * @param toolInput Tool input payload
 * @param trigger Approval trigger type
 * @param autoApprove Whether to auto-approve immediately
 * @returns Approval document ID
 */
export const createForGateway = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    approvalId: v.string(),
    toolCallId: v.string(),
    toolName: v.string(),
    toolInput: v.any(),
    trigger: v.optional(approvalTriggerEnum),
    autoApprove: v.optional(v.boolean()),
    workflowId: v.optional(v.string()),
  },
  returns: v.id("toolApprovals"),
  handler: async (ctx, args) => {
    const {
      sessionId,
      approvalId,
      toolCallId,
      toolName,
      toolInput,
      trigger,
      autoApprove,
      workflowId,
    } = args;

    const existing = await ctx.db
      .query("toolApprovals")
      .withIndex("by_approvalId", (q) => q.eq("approvalId", approvalId))
      .first();
    if (existing) {
      return existing._id;
    }

    return await ctx.db.insert("toolApprovals", {
      sessionId: sessionId,
      approvalId: approvalId,
      toolCallId: toolCallId,
      toolName: toolName,
      toolInput: toolInput,
      status: autoApprove ? "granted" : "pending",
      reason: undefined,
      respondedAt: autoApprove ? Date.now() : undefined,
      trigger: trigger ?? (autoApprove ? "auto" : "manual"),
      workflowId: workflowId,
    });
  },
});

/**
 * Respond to one approval by approvalId.
 * @param sessionId Session ID for ownership scoping
 * @param approvalId Approval identifier
 * @param approved Decision flag
 * @param reason Optional decision reason
 * @returns Normalized approval decision payload, or null when not found
 */
export const respondForGateway = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    approvalId: v.string(),
    approved: v.boolean(),
    reason: v.optional(v.string()),
  },
  returns: v.union(approvalDecisionValidator, v.null()),
  handler: async (ctx, args) => {
    const { sessionId, approvalId, approved, reason } = args;

    const approval = await ctx.db
      .query("toolApprovals")
      .withIndex("by_approvalId", (q) => q.eq("approvalId", approvalId))
      .first();

    if (!approval || approval.sessionId !== sessionId) {
      return null;
    }

    let finalApproval: Doc<"toolApprovals"> = approval;

    if (approval.status === "pending") {
      const nextStatus: Doc<"toolApprovals">["status"] = approved ? "granted" : "denied";
      await ctx.db.patch(approval._id, {
        status: nextStatus,
        reason: reason,
        respondedAt: Date.now(),
      });

      finalApproval = {
        ...approval,
        status: nextStatus,
        reason: reason,
        respondedAt: Date.now(),
      };
    }

    return {
      approvalDocId: finalApproval._id,
      approvalId: finalApproval.approvalId,
      toolName: finalApproval.toolName,
      toolInput: finalApproval.toolInput,
      status: finalApproval.status,
      reason: finalApproval.reason,
    };
  },
});

/**
 * Fetch approval docs by IDs (used when resume payload already includes IDs).
 * @param sessionId Session scope
 * @param approvalIds Approval IDs to resolve
 * @returns Matching approval docs
 */
export const listByApprovalIdsForGateway = internalQuery({
  args: {
    sessionId: v.id("sessions"),
    approvalIds: v.array(v.string()),
  },
  returns: v.array(toolApprovalValidator),
  handler: async (ctx, args) => {
    const { sessionId, approvalIds } = args;

    const uniqueIds = Array.from(new Set(approvalIds));
    const approvals = await Promise.all(
      uniqueIds.map((approvalId) =>
        ctx.db
          .query("toolApprovals")
          .withIndex("by_approvalId", (q) => q.eq("approvalId", approvalId))
          .first(),
      ),
    );

    return approvals
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .filter((item) => item.sessionId === sessionId);
  },
});
