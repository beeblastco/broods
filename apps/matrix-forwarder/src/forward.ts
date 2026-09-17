/**
 * POSTs a decrypted room message to every channel webhook its access token
 * serves, in the shape `apps/core/src/shared/matrix-wire.ts` accepts.
 *
 * Nothing is filtered here: not rooms, not senders, not edits, not the account's
 * own messages. The account is usually a person's, so which of those is a
 * trigger is a product rule, and core owns it.
 */

import {
  MATRIX_ACCESS_TOKEN_HEADER,
  type MatrixForwardedEvent,
} from "../../core/src/shared/matrix-wire.ts";
import {
  logError,
  logWarn,
  tokenHint,
} from "../../discord-forwarder/src/log.ts";
import type { RoomEvent } from "./matrix.ts";

// Bun puts no deadline on `fetch`. A webhook that accepts and never answers
// would otherwise stall the account's sync loop, which awaits each delivery to
// keep timeline order.
const FETCH_TIMEOUT_MS = 10_000;

export interface ForwardedEventInput {
  encrypted: boolean;
  event: RoomEvent;
  roomId: string;
  senderName: string | undefined;
  userId: string;
}

export interface ForwardTarget {
  agentId: string;
  agentName: string;
  webhookUrl: string;
}

/** Keeps only the event fields the wire contract names. */
export function forwardedEvent(
  input: ForwardedEventInput,
): MatrixForwardedEvent {
  return {
    type: "MATRIX_ROOM_EVENT",
    encrypted: input.encrypted,
    event: {
      content: input.event.content,
      event_id: input.event.event_id,
      origin_server_ts: input.event.origin_server_ts,
      sender: input.event.sender,
      type: "m.room.message",
    },
    roomId: input.roomId,
    senderName: input.senderName,
    userId: input.userId,
  };
}

/** Never throws: a failed delivery is logged and skipped, like the Discord forwarder. */
export async function forwardRoomEvent(
  event: MatrixForwardedEvent,
  accessToken: string,
  targets: readonly ForwardTarget[],
): Promise<void> {
  const body = JSON.stringify(event);

  await Promise.all(
    targets.map((target): Promise<void> =>
      post(target, body, accessToken, event),
    ),
  );
}

async function post(
  target: ForwardTarget,
  body: string,
  accessToken: string,
  event: MatrixForwardedEvent,
): Promise<void> {
  try {
    const response = await fetch(target.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [MATRIX_ACCESS_TOKEN_HEADER]: accessToken,
      },
      body: body,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      logWarn("Forward rejected by core", {
        agentId: target.agentId,
        agentName: target.agentName,
        eventId: event.event.event_id,
        status: response.status,
        tokenHint: tokenHint(accessToken),
      });
    }
  } catch (error) {
    logError("Forward failed", {
      agentId: target.agentId,
      agentName: target.agentName,
      error: error instanceof Error ? error.message : String(error),
      eventId: event.event.event_id,
      tokenHint: tokenHint(accessToken),
    });
  }
}
