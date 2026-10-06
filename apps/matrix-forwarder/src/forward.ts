/**
 * POSTs a decrypted room message to every channel webhook its access token
 * serves, in the shape `apps/core/src/shared/matrix-wire.ts` accepts. The
 * delivery itself is `fanOut`, shared with the Discord forwarder.
 *
 * The only event dropped here is one this channel sent: it carries the marker,
 * it comes back through `/sync` like any other message, and core would only
 * discard it again. Everything else goes, rooms, senders and edits included,
 * because the account is usually a person's and which message is a trigger is
 * core's decision.
 */

import {
  MATRIX_ACCESS_TOKEN_HEADER,
  MATRIX_BOT_MARKER,
  type MatrixForwardedEvent,
} from "../../core/src/shared/matrix-wire.ts";
import {
  fanOut,
  type ForwardTarget,
} from "../../discord-forwarder/src/forward.ts";
import type { RoomEvent } from "./matrix.ts";

// Bun puts no deadline on `fetch`. A webhook that accepts and never answers
// would otherwise stall the account's sync loop, which awaits each delivery to
// keep timeline order.
const FETCH_TIMEOUT_MS = 10_000;

interface ForwardedEventInput {
  encrypted: boolean;
  event: RoomEvent;
  roomId: string;
  senderName: string | undefined;
  userId: string;
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

export async function forwardRoomEvent(
  event: MatrixForwardedEvent,
  accessToken: string,
  targets: readonly ForwardTarget[],
): Promise<void> {
  await fanOut(
    targets,
    JSON.stringify(event),
    {
      header: MATRIX_ACCESS_TOKEN_HEADER,
      timeoutMs: FETCH_TIMEOUT_MS,
      token: accessToken,
    },
    { eventId: event.event.event_id },
  );
}

/** True for a message this channel sent, which nothing downstream wants. */
export function isOwnMessage(content: Record<string, unknown>): boolean {
  return content[MATRIX_BOT_MARKER] === true;
}
