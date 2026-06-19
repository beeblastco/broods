/**
 * Agent lifecycle event delivery.
 * This is for the webhook event delivery and event hook configuration
 * Keep stable event payloads and subscriber transport wiring here.
 */

import type { JSONValue } from "ai";
import type { AgentConfig, AgentLifecycleEventName } from "../_shared/storage/index.ts";
import { logError } from "../_shared/log.ts";
import { fireWebhook } from "../_shared/webhook.ts";
import type { Session } from "./session.ts";

export type AgentLifecycleEventPayload = Record<string, JSONValue | undefined>;

export interface AgentLifecycleEvent {
  type: AgentLifecycleEventName;
  timestamp: string;
  accountId?: string;
  agentId?: string;
  eventId: string;
  conversationKey: string;
  payload: AgentLifecycleEventPayload;
}

export interface AgentLifecycleEmitter {
  emit(type: AgentLifecycleEventName, payload?: AgentLifecycleEventPayload): Promise<void>;
}

export function createAgentLifecycleEmitter(
  session: Pick<Session, "accountId" | "agentId" | "eventId" | "conversationKey">,
  agentConfig: AgentConfig,
): AgentLifecycleEmitter {
  // An agent can register several outbound webhooks; keep only deliverable ones
  // (enabled with both a URL and a signing secret).
  const webhooks = (agentConfig.hooks?.webhooks ?? []).filter(
    (webhook) => webhook?.enabled && webhook.url && webhook.secret,
  );

  return {
    async emit(type, payload = {}) {
      // A webhook with no events allow-list receives every event; otherwise only
      // the events it subscribed to.
      const targets = webhooks.filter((webhook) => !webhook.events || webhook.events.includes(type));
      if (targets.length === 0) {
        return;
      }

      const event = {
        type,
        timestamp: new Date().toISOString(),
        ...(session.accountId ? { accountId: session.accountId } : {}),
        ...(session.agentId ? { agentId: session.agentId } : {}),
        eventId: session.eventId,
        conversationKey: session.conversationKey,
        payload,
      } satisfies AgentLifecycleEvent;

      await Promise.all(targets.map(async (webhook) => {
        if (!webhook.url || !webhook.secret) {
          return;
        }
        try {
          await fireWebhook({ url: webhook.url, secret: webhook.secret }, event);
        } catch (err) {
          logError("Lifecycle webhook delivery failed", {
            eventType: type,
            eventId: session.eventId,
            url: webhook.url,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }));
    },
  };
}

export function toLifecycleValue(value: unknown): JSONValue | undefined {
  if (value === undefined) {
    return undefined;
  }

  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : JSON.parse(serialized) as JSONValue;
  } catch {
    return String(value);
  }
}
