/**
 * The one home for "what fires a cron job": a recurring schedule is a
 * crons-component registration named by the row id, a one-time at(...) job is
 * a Convex scheduler run recorded in the row's `scheduledRunId`. create,
 * update, the account/project cascades, and the cutover migration all
 * register and deschedule through here, so the convention cannot drift.
 */

import { Crons } from "@convex-dev/crons";
import { components, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { translateScheduleExpression } from "./cronRules";

export const cronSchedules = new Crons(components.crons);

export interface RegisteredSchedule {
  registered: boolean;
  /** Set for a one-time at(...) job; the caller stores it on the row. */
  scheduledRunId?: Id<"_scheduled_functions">;
}

export interface RegisterScheduleOptions {
  /**
   * What to do with an at(...) instant that already passed: "throw" rejects
   * the write (create, or an update changing the expression), "run" fires it
   * immediately (resuming a job whose time went by), "skip" leaves it
   * unregistered (the cutover migration, where it already fired).
   */
  onPastAt: "throw" | "run" | "skip";
}

/**
 * Registers the schedule that fires one cron job; a non-active job registers
 * nothing. The returned `scheduledRunId` is the caller's to fold into its own
 * row write, keeping one patch per mutation.
 */
export async function registerSchedule(
  ctx: MutationCtx,
  cron: Doc<"crons">,
  options: RegisterScheduleOptions,
): Promise<RegisteredSchedule> {
  if (cron.status !== "active") return { registered: false };
  const schedule = translateScheduleExpression(
    cron.scheduleExpression,
    cron.timezone,
  );
  if (schedule.kind !== "at") {
    await cronSchedules.register(
      ctx,
      schedule,
      internal.agent.crons.dispatch,
      { accountId: cron.accountId, cronId: cron._id },
      cron._id,
    );

    return { registered: true };
  }
  if (schedule.timestamp <= Date.now()) {
    if (options.onPastAt === "throw") {
      throw new Error("at(...) time must be in the future");
    }
    if (options.onPastAt === "skip") return { registered: false };
  }
  const scheduledRunId = await ctx.scheduler.runAt(
    schedule.timestamp,
    internal.agent.crons.dispatch,
    { accountId: cron.accountId, cronId: cron._id },
  );

  return { registered: true, scheduledRunId: scheduledRunId };
}

/**
 * Deschedules whatever fires this cron job; a missing schedule is done.
 * A one-time job lives in `scheduledRunId` and is never in the component, so
 * the cross-component lookup only runs for recurring rows. Clearing the
 * `scheduledRunId` field is the caller's write.
 */
export async function unregisterSchedule(
  ctx: MutationCtx,
  cron: Doc<"crons">,
): Promise<void> {
  if (cron.scheduledRunId) {
    await ctx.scheduler.cancel(cron.scheduledRunId);

    return;
  }
  if (await cronSchedules.get(ctx, { name: cron._id })) {
    await cronSchedules.delete(ctx, { name: cron._id });
  }
}
