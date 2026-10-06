/**
 * Sends an event core asked for into a room. Core cannot do this itself for an
 * encrypted room: the device keys live in this process's crypto store.
 */

import type { MatrixSendRequest } from "../../core/src/shared/matrix-wire.ts";
import type { RoomCrypto } from "./crypto.ts";
import type { MatrixClient } from "./matrix.ts";

// One deadline for the whole send, under core's 30s wait on `/v1/send`: a
// reply fails for both sides rather than landing after core gave up on it.
const SEND_TIMEOUT_MS = 25_000;

/** Encrypts and sends `m.room.encrypted` in an encrypted room, sends as-is otherwise. Returns the event id. */
export async function sendRoomEvent(
  client: Pick<MatrixClient, "sendEvent">,
  crypto: Pick<RoomCrypto, "encrypt" | "isEncrypted">,
  request: MatrixSendRequest,
): Promise<string> {
  const signal = AbortSignal.timeout(SEND_TIMEOUT_MS);
  if (!(await crypto.isEncrypted(request.roomId, signal))) {
    return client.sendEvent(
      request.roomId,
      request.type,
      request.content,
      signal,
    );
  }
  const encrypted = await crypto.encrypt(
    request.roomId,
    request.type,
    request.content,
    signal,
  );

  return client.sendEvent(
    request.roomId,
    "m.room.encrypted",
    encrypted,
    signal,
  );
}
