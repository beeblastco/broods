/**
 * End-to-end encryption for one account's device: matrix-rust-sdk's OlmMachine
 * over a SQLite store on disk. Only one OlmMachine may ever have a store open,
 * which is why decrypting and encrypting both live in this process.
 *
 * The only module that loads the native binding at runtime. Everything else
 * imports it as a type, so the tests run where the `.node` file was never
 * downloaded (CI installs with `--ignore-scripts`).
 */

import {
  DeviceId,
  DeviceLists,
  EncryptionSettings,
  KeysClaimRequest,
  KeysQueryRequest,
  KeysUploadRequest,
  OlmMachine,
  RoomId,
  RoomMessageRequest,
  SignatureUploadRequest,
  ToDeviceRequest,
  UserId,
} from "@matrix-org/matrix-sdk-crypto-nodejs";
import { logWarn } from "../../discord-forwarder/src/log.ts";
import type { MatrixClient, RoomEvent, SyncResponse } from "./matrix.ts";

type OutgoingRequest = Awaited<
  ReturnType<OlmMachine["outgoingRequests"]>
>[number];

export class RoomCrypto {
  private readonly client: MatrixClient;
  private readonly encryptedRooms = new Set<string>();
  private readonly machine: OlmMachine;
  /** OlmMachine wants one key claim and one outgoing-request flush at a time. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Room id to its joined members, dropped when a sync reports device changes. */
  private readonly roomMembers = new Map<string, string[]>();

  private constructor(client: MatrixClient, machine: OlmMachine) {
    this.client = client;
    this.machine = machine;
  }

  /**
   * Opens the device's store. Keys are uploaded by the first `receiveSync`, not
   * here, so a failed open never leaves a machine behind that nobody closes.
   */
  static async open(
    client: MatrixClient,
    userId: string,
    deviceId: string,
    storePath: string,
  ): Promise<RoomCrypto> {
    // SQLite is the only store type, and the default once a path is given.
    const machine = await OlmMachine.initialize(
      new UserId(userId),
      new DeviceId(deviceId),
      storePath,
    );

    return new RoomCrypto(client, machine);
  }

  /** Waits for an in-flight encrypt or flush, then releases the store. */
  async close(): Promise<void> {
    await this.exclusive(async (): Promise<void> => this.machine.close());
  }

  /**
   * Returns the event with its plaintext type and content. Throws while the room
   * key has not arrived, which is often a sync or two after the message.
   */
  async decrypt(roomId: string, event: RoomEvent): Promise<RoomEvent> {
    const decrypted = await this.machine.decryptRoomEvent(
      JSON.stringify(event),
      new RoomId(roomId),
    );
    const plaintext: Pick<RoomEvent, "content" | "type"> = JSON.parse(
      decrypted.event,
    );

    return { ...event, content: plaintext.content, type: plaintext.type };
  }

  /** Shares the room key with every joined member's devices, then returns `m.room.encrypted` content. */
  async encrypt(
    roomId: string,
    type: string,
    content: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    // Fetched outside the lock: a member list is the homeserver's, not the
    // machine's, so holding the store for it stalls every other room.
    const joined = await this.members(roomId);

    return this.exclusive(async (): Promise<Record<string, unknown>> => {
      const members = joined.map((userId): UserId => new UserId(userId));
      const room = new RoomId(roomId);
      await this.machine.updateTrackedUsers(members);
      await this.flushOutgoing();
      const claim = await this.machine.getMissingSessions(members);
      if (claim !== null) await this.send(claim);
      for (const request of await this.machine.shareRoomKey(
        room,
        members,
        new EncryptionSettings(),
      )) {
        await this.send(request);
      }
      const ciphertext: Record<string, unknown> = JSON.parse(
        await this.machine.encryptRoomEvent(
          room,
          type,
          JSON.stringify(content),
        ),
      );

      return ciphertext;
    });
  }

  /** Encryption cannot be turned off in a room, so only `true` is cached. */
  async isEncrypted(roomId: string): Promise<boolean> {
    if (this.encryptedRooms.has(roomId)) return true;
    const encrypted = await this.client.roomEncrypted(roomId);
    if (encrypted) this.encryptedRooms.add(roomId);

    return encrypted;
  }

  /** Must run before the same sync's timeline: its to-device events may carry that timeline's room keys. */
  async receiveSync(response: SyncResponse): Promise<void> {
    await this.exclusive(async (): Promise<void> => {
      await this.machine.receiveSyncChanges(
        JSON.stringify(response.to_device?.events ?? []),
        new DeviceLists(
          toUserIds(response.device_lists?.changed),
          toUserIds(response.device_lists?.left),
        ),
        response.device_one_time_keys_count ?? {},
        response.device_unused_fallback_key_types ?? [],
      );
      // A user who joins an encrypted room arrives in `changed` and one who
      // leaves arrives in `left`, so either list means a cached member list is
      // stale. `left` matters most: `encrypt` hands that list to
      // `shareRoomKey`, which would give a departed user the next room key.
      if (
        response.device_lists?.changed?.length ||
        response.device_lists?.left?.length
      ) {
        this.roomMembers.clear();
      }
      try {
        await this.flushOutgoing();
      } catch (error) {
        // Unsent requests come back from outgoingRequests() on the next sync.
        logWarn("Matrix crypto request failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.catch((): undefined => undefined);

    return result;
  }

  private async flushOutgoing(): Promise<void> {
    for (const request of await this.machine.outgoingRequests()) {
      await this.send(request);
    }
  }

  /** Joined user ids, cached so a reply does not cost a round trip to list them. */
  private async members(roomId: string): Promise<string[]> {
    const cached = this.roomMembers.get(roomId);
    if (cached) return cached;
    const joined = [...(await this.client.joinedMembers(roomId)).keys()];
    this.roomMembers.set(roomId, joined);

    return joined;
  }

  private async send(request: OutgoingRequest): Promise<void> {
    const [method, path] = route(request);
    const response = await this.client.rawRequest(method, path, request.body);
    await this.machine.markRequestAsSent(request.id, request.type, response);
  }
}

function route(request: OutgoingRequest): [method: string, path: string] {
  if (request instanceof KeysUploadRequest) return ["POST", "/keys/upload"];
  if (request instanceof KeysQueryRequest) return ["POST", "/keys/query"];
  if (request instanceof KeysClaimRequest) return ["POST", "/keys/claim"];
  if (request instanceof SignatureUploadRequest) {
    return ["POST", "/keys/signatures/upload"];
  }
  if (request instanceof ToDeviceRequest) {
    return [
      "PUT",
      `/sendToDevice/${encodeURIComponent(request.eventType)}/${encodeURIComponent(request.txnId)}`,
    ];
  }
  if (request instanceof RoomMessageRequest) {
    return [
      "PUT",
      `/rooms/${encodeURIComponent(request.roomId)}/send/${encodeURIComponent(request.eventType)}/${encodeURIComponent(request.txnId)}`,
    ];
  }

  throw new Error("Unhandled Matrix crypto request type");
}

function toUserIds(userIds: string[] | undefined): UserId[] {
  return (userIds ?? []).map((userId): UserId => new UserId(userId));
}
