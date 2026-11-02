import type { MatrixSendRequest } from "../../core/src/shared/matrix-wire.ts";
import type { RoomCrypto } from "./crypto.ts";
import type { MatrixClient } from "./matrix.ts";

// Under core's 30 s wait on /v1/send, so a reply never lands after core gave up on it.
const SEND_TIMEOUT_MS = 25_000;

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
