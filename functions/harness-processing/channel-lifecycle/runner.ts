/**
 * Channel lifecycle runner utilities.
 * Keep generic hook execution here so handler.ts remains orchestration-focused.
 */

import type { SystemModelMessage } from "ai";
import type { ChannelInboundEvent } from "../integrations.ts";
import { logError, logInfo } from "../../_shared/log.ts";
import type {
  ChannelLifecycleComponent,
  ChannelLifecycleContext,
  ChannelReplyResult,
} from "./types.ts";

export function createChannelLifecycleContext(event: ChannelInboundEvent): ChannelLifecycleContext {
  return {
    accountId: event.accountId,
    agentId: event.agentId,
    eventId: event.eventId,
    conversationKey: event.conversationKey,
    channelName: event.channelName,
    content: event.content,
    source: event.source,
  };
}

export async function runBeforeChannelReply(
  components: ChannelLifecycleComponent[] | undefined,
  context: ChannelLifecycleContext,
): Promise<{ stop: boolean; ephemeralSystem: SystemModelMessage[] }> {
  const ephemeralSystem: SystemModelMessage[] = [];
  for (const component of components ?? []) {
    const result = await component.before?.(context);
    if (result?.stop) {
      logInfo("Channel request stopped by lifecycle component", {
        eventId: context.eventId,
        conversationKey: context.conversationKey,
        component: component.name,
        reason: result.reason ?? "lifecycle_blocked",
      });
      return { stop: true, ephemeralSystem };
    }

    if (result?.ephemeralSystem) {
      ephemeralSystem.push(...result.ephemeralSystem);
    }
  }

  return { stop: false, ephemeralSystem };
}

export async function runAfterChannelReply(
  components: ChannelLifecycleComponent[] | undefined,
  context: ChannelLifecycleContext,
  result: ChannelReplyResult,
): Promise<void> {
  await Promise.all((components ?? []).map(async (component) => {
    if (!component.after) {
      return;
    }

    await component.after(context, result).catch((err) => {
      logError("Failed to run channel lifecycle after hook", {
        eventId: context.eventId,
        conversationKey: context.conversationKey,
        component: component.name,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }));
}
