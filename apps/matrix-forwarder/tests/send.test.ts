import { describe, expect, it } from "bun:test";
import type { MatrixSendRequest } from "../../core/src/shared/matrix-wire.ts";
import { sendRoomEvent } from "../src/send.ts";

const REQUEST: MatrixSendRequest = {
  content: { body: "done", msgtype: "m.text" },
  roomId: "!room:example.org",
  type: "m.room.message",
};

interface Sent {
  content: Record<string, unknown>;
  roomId: string;
  type: string;
}

function fakes(encrypted: boolean): {
  client: Parameters<typeof sendRoomEvent>[0];
  crypto: Parameters<typeof sendRoomEvent>[1];
  encryptedTypes: string[];
  sent: Sent[];
} {
  const sent: Sent[] = [];
  const encryptedTypes: string[] = [];
  async function sendEvent(
    roomId: string,
    type: string,
    content: Record<string, unknown>,
  ): Promise<string> {
    sent.push({ content: content, roomId: roomId, type: type });

    return "$sent";
  }
  async function encrypt(
    _roomId: string,
    type: string,
  ): Promise<Record<string, unknown>> {
    encryptedTypes.push(type);

    return { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "opaque" };
  }

  return {
    client: { sendEvent: sendEvent },
    crypto: {
      encrypt: encrypt,
      isEncrypted: async (): Promise<boolean> => encrypted,
    },
    encryptedTypes: encryptedTypes,
    sent: sent,
  };
}

describe("sending into a room", () => {
  it("sends the event type as-is into a plain room", async () => {
    const { client, crypto, encryptedTypes, sent } = fakes(false);

    await expect(sendRoomEvent(client, crypto, REQUEST)).resolves.toBe("$sent");
    expect(encryptedTypes).toEqual([]);
    expect(sent).toEqual([
      {
        content: REQUEST.content,
        roomId: REQUEST.roomId,
        type: "m.room.message",
      },
    ]);
  });

  it("encrypts and sends m.room.encrypted into an encrypted room", async () => {
    const { client, crypto, encryptedTypes, sent } = fakes(true);

    await expect(sendRoomEvent(client, crypto, REQUEST)).resolves.toBe("$sent");
    expect(encryptedTypes).toEqual(["m.room.message"]);
    expect(sent).toEqual([
      {
        content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "opaque" },
        roomId: REQUEST.roomId,
        type: "m.room.encrypted",
      },
    ]);
  });
});
