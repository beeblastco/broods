/**
 * The wire shapes core and `apps/matrix-forwarder` share. No imports on purpose:
 * the forwarder bundles this file by relative path, and anything imported here
 * would ship in its image too. Core's adapter is `matrix-channel.ts`.
 */

/** Header both directions authenticate with: the account's access token. */
export const MATRIX_ACCESS_TOKEN_HEADER = "x-matrix-access-token";

/** Forwarder → core, one room message, already decrypted. */
export interface MatrixForwardedEvent {
  type: "MATRIX_ROOM_EVENT";
  /** Whether the room is encrypted, so replies and uploads must be too. */
  encrypted: boolean;
  event: MatrixRoomMessageEvent;
  roomId: string;
  /** The sender's display name in the room, when they set one. */
  senderName?: string;
  /** The account the access token belongs to. */
  userId: string;
}

/** A decrypted `m.room.message`, as the client-server API serves it. */
export interface MatrixRoomMessageEvent {
  content: Record<string, unknown>;
  event_id: string;
  origin_server_ts: number;
  sender: string;
  type: "m.room.message";
}

/** Core → forwarder `POST /v1/send`. Answered with {@link MatrixSendResponse}. */
export interface MatrixSendRequest {
  content: Record<string, unknown>;
  roomId: string;
  type: "m.reaction" | "m.room.message";
}

export interface MatrixSendResponse {
  eventId: string;
}

/** Core → forwarder `POST /v1/typing`. Answered with 204. */
export interface MatrixTypingRequest {
  roomId: string;
  typing: boolean;
}
