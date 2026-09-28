/**
 * Agent lifecycle event delivery.
 * Keep stable event payloads and subscriber transport wiring here.
 */

import type { JSONValue } from "ai";
import type {
  AgentConfig,
  AgentLifecycleEventName,
} from "../shared/domain/agent-config.ts";
import type { PinnedFetchTransport } from "../shared/http.ts";
import { logError } from "../shared/log.ts";
import { fireWebhook } from "../shared/webhook.ts";
import type { Session } from "./session.ts";

/** Event-specific fields of a lifecycle event, also the payload handed to code hooks. */
export type AgentLifecycleEventPayload = Record<string, JSONValue | undefined>;

/** The JSON body posted to a lifecycle webhook. */
export interface AgentLifecycleEvent {
  type: AgentLifecycleEventName;
  timestamp: string;
  accountId?: string;
  agentId?: string;
  eventId: string;
  conversationKey: string;
  payload: AgentLifecycleEventPayload;
}

/** What the harness and subagent coordinator call to announce a lifecycle event. */
export interface AgentLifecycleEmitter {
  emit(
    type: AgentLifecycleEventName,
    payload?: AgentLifecycleEventPayload,
  ): Promise<void>;
}

/**
 * Built once per run by the harness, and by the subagent coordinator for its
 * parent session. `emit` posts a signed event to every
 * enabled lifecycle webhook subscribed to that type; delivery failures are logged.
 */
export function createAgentLifecycleEmitter(
  session: Pick<
    Session,
    "accountId" | "agentId" | "eventId" | "conversationKey"
  >,
  agentConfig: AgentConfig,
  transport?: PinnedFetchTransport,
): AgentLifecycleEmitter {
  const webhooks = (agentConfig.hooks?.webhooks ?? []).filter(
    (webhook) => webhook?.enabled && webhook.url && webhook.secret,
  );

  return {
    emit: async function (type, payload = {}): Promise<void> {
      const targets = webhooks.filter(
        (webhook) => !webhook.events || webhook.events.includes(type),
      );
      if (targets.length === 0) {
        return;
      }

      const event: AgentLifecycleEvent = {
        type: type,
        timestamp: new Date().toISOString(),
        ...(session.accountId ? { accountId: session.accountId } : {}),
        ...(session.agentId ? { agentId: session.agentId } : {}),
        eventId: session.eventId,
        conversationKey: session.conversationKey,
        payload: payload,
      };

      await Promise.all(
        targets.map(async (webhook) => {
          if (!webhook.url || !webhook.secret) {
            return;
          }
          try {
            await fireWebhook(
              { url: webhook.url, secret: webhook.secret },
              event,
              transport,
            );
          } catch (err) {
            logError("Lifecycle webhook delivery failed", {
              eventType: type,
              eventId: session.eventId,
              url: webhook.url,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }),
      );
    },
  };
}

/**
 * Turns any value into plain JSON for a lifecycle or hook payload, falling back
 * to its string form when it does not serialize.
 */
export function toLifecycleValue(value: unknown): JSONValue | undefined {
  if (value === undefined) {
    return undefined;
  }

  try {
    const serialized = JSON.stringify(value);

    return serialized === undefined
      ? String(value)
      : (JSON.parse(serialized) as JSONValue);
  } catch {
    return String(value);
  }
}
