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

// Bun's fetch has no deadline; a silent webhook would stall the account's delivery loop.
const FETCH_TIMEOUT_MS = 10_000;

interface ForwardedEventInput {
  encrypted: boolean;
  event: RoomEvent;
  roomId: string;
  senderName: string | undefined;
  userId: string;
}

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

/** Resolves the webhook URLs that may still take the event on a later try. */
export async function forwardRoomEvent(
  event: MatrixForwardedEvent,
  accessToken: string,
  targets: readonly ForwardTarget[],
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<string[]> {
  return fanOut(
    targets,
    JSON.stringify(event),
    {
      header: MATRIX_ACCESS_TOKEN_HEADER,
      timeoutMs: timeoutMs,
      token: accessToken,
    },
    { eventId: event.event.event_id },
  );
}

export function isOwnMessage(content: Record<string, unknown>): boolean {
  return content[MATRIX_BOT_MARKER] === true;
}
