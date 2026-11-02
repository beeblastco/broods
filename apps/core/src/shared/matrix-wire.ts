// No imports: `apps/matrix-forwarder` bundles this file by relative path.

export const MATRIX_ACCESS_TOKEN_HEADER = "x-matrix-access-token";

// The account is usually a person's, so the sender cannot tell agent replies from the owner's.
export const MATRIX_BOT_MARKER = "app.broods.bot";

export interface MatrixForwardedEvent {
  type: "MATRIX_ROOM_EVENT";
  encrypted: boolean;
  event: MatrixRoomMessageEvent;
  roomId: string;
  senderName?: string;
  /** The account's own user, not the sender. */
  userId: string;
}

export interface MatrixRoomMessageEvent {
  content: Record<string, unknown>;
  event_id: string;
  origin_server_ts: number;
  sender: string;
  type: "m.room.message";
}

export interface MatrixSendRequest {
  content: Record<string, unknown>;
  roomId: string;
  type: "m.reaction" | "m.room.message";
}

export interface MatrixSendResponse {
  eventId: string;
}

export interface MatrixTypingRequest {
  roomId: string;
  typing: boolean;
}
