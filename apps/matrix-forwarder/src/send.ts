/**
 * Sends an event core asked for into a room. Core cannot do this itself for an
 * encrypted room: the device keys live in this process's crypto store.
 */

import type { MatrixSendRequest } from "../../core/src/shared/matrix-wire.ts";
import type { RoomCrypto } from "./crypto.ts";
import type { MatrixClient } from "./matrix.ts";

/** Encrypts and sends `m.room.encrypted` in an encrypted room, sends as-is otherwise. Returns the event id. */
export async function sendRoomEvent(
  client: Pick<MatrixClient, "sendEvent">,
  crypto: Pick<RoomCrypto, "encrypt" | "isEncrypted">,
  request: MatrixSendRequest,
): Promise<string> {
  if (!(await crypto.isEncrypted(request.roomId))) {
    return client.sendEvent(request.roomId, request.type, request.content);
  }
  const encrypted = await crypto.encrypt(
    request.roomId,
    request.type,
    request.content,
  );

  return client.sendEvent(request.roomId, "m.room.encrypted", encrypted);
}
