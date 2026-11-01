import { Crons } from "@convex-dev/crons";
import { components, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx, MutationCtx } from "../_generated/server";
import { translateScheduleExpression } from "./cronRules";
import { ClientError } from "./clientError";

export const cronSchedules = new Crons(components.crons);

export interface RegisterScheduleOptions {
  /** For an at(...) instant already past: "run" fires it now, as a resume does. */
  onPastAt: "throw" | "run";
}

export async function deleteCron(
  ctx: MutationCtx,
  cron: Doc<"crons">,
): Promise<void> {
  await unregisterSchedule(ctx, cron);
  // Run history can outgrow one transaction, so a scheduled mutation drains it in batches.
  await ctx.scheduler.runAfter(0, internal.agent.crons.removeRunsCascade, {
    accountId: cron.accountId,
    cronId: cron._id,
  });
  await ctx.db.delete(cron._id);
}

// The probe is load-bearing: the component's delete throws on an unknown name.
export async function deleteRegistrationIfExists(
  ctx: MutationCtx | ActionCtx,
  name: string,
): Promise<void> {
  if (await cronSchedules.get(ctx, { name: name })) {
    await cronSchedules.delete(ctx, { name: name });
  }
}

// Returns an at(...) job's `scheduledRunId` for the caller's own row write: one patch per mutation.
export async function registerSchedule(
  ctx: MutationCtx,
  cron: Doc<"crons">,
  options: RegisterScheduleOptions,
): Promise<Id<"_scheduled_functions"> | undefined> {
  if (cron.status !== "active") return undefined;
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

    return undefined;
  }
  if (schedule.timestamp <= Date.now() && options.onPastAt === "throw") {
    throw new ClientError("at(...) time must be in the future");
  }
  const scheduledRunId = await ctx.scheduler.runAt(
    schedule.timestamp,
    internal.agent.crons.dispatch,
    { accountId: cron.accountId, cronId: cron._id },
  );

  return scheduledRunId;
}

// An at(...) job is never in the component and a non-active one holds no registration.
// Clearing `scheduledRunId` is the caller's write.
export async function unregisterSchedule(
  ctx: MutationCtx,
  cron: Doc<"crons">,
): Promise<void> {
  if (cron.scheduledRunId) {
    await ctx.scheduler.cancel(cron.scheduledRunId);

    return;
  }
  if (cron.status !== "active") return;
  await deleteRegistrationIfExists(ctx, cron._id);
}
