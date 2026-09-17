import { afterEach, describe, expect, it } from "bun:test";
import type {
  ChannelAdapter,
  ChannelParseResult,
  ChannelRequest,
  InboundMessage,
} from "../src/shared/channels.ts";
import {
  createMatrixActions,
  createMatrixChannel,
  MATRIX_BOT_MARKER,
  type MatrixChannelOptions,
  type MatrixSource,
} from "../src/shared/matrix-channel.ts";
import {
  MATRIX_ACCESS_TOKEN_HEADER,
  type MatrixForwardedEvent,
} from "../src/shared/matrix-wire.ts";
import { channelScopeKeyFromConversation } from "../src/shared/runtime-keys.ts";

const API_URL = "https://matrix.example.org";
const ROOM_ID = "!room:example.org";
const TOKEN = "syt_token";

const originalFetch = globalThis.fetch;
const originalForwarderUrl = process.env.MATRIX_FORWARDER_URL;

interface CapturedCall {
  body: unknown;
  token: string | null;
  url: string;
}

afterEach((): void => {
  globalThis.fetch = originalFetch;
  process.env.MATRIX_FORWARDER_URL = originalForwarderUrl;
});

describe("matrix channel adapter", () => {
  it("authenticates the forwarder by the account's access token", () => {
    const adapter = channel();

    expect(
      adapter.authenticate(request(forwarded({ body: "hi" }), TOKEN)),
    ).toBe(true);
    expect(
      adapter.authenticate(request(forwarded({ body: "hi" }), "other")),
    ).toBe(false);
  });

  it("stores a message that does not address the agent as context", async () => {
    const parsed = await channel().parse(
      request(forwarded({ body: "the demo is friday" })),
    );

    expect(parsed).toMatchObject({
      kind: "context",
      message: {
        channelName: "matrix",
        content: [{ type: "text", text: "Georgi: the demo is friday" }],
        conversationKey: `matrix:${ROOM_ID}`,
        eventId: "matrix:$event-1",
        identity: {
          channelId: ROOM_ID,
          userId: "@georgi:example.org",
          userName: "Georgi",
        },
        source: {
          encrypted: false,
          messageId: "$event-1",
          roomId: ROOM_ID,
          userId: "@georgi:example.org",
        },
      },
    });
  });

  it("runs the agent on the mention text and drops it from the prompt", async () => {
    const parsed = await channel({ mentionText: "@georgi-ai" }).parse(
      request(forwarded({ body: "@Georgi-AI what is due?" })),
    );

    expect(parsed.kind).toBe("message");
    expect(messageOf(parsed).content).toEqual([
      { type: "text", text: "Georgi: what is due?" },
    ]);
  });

  it("runs the agent on a mention pill that carries the server", async () => {
    const parsed = await channel({ mentionText: "@georgi-ai" }).parse(
      request(
        forwarded({
          body: "you have a new look @georgi-ai:matrix.eemcs.utwente.nl",
        }),
      ),
    );

    expect(parsed.kind).toBe("message");
    expect(messageOf(parsed).content).toEqual([
      { type: "text", text: "Georgi: you have a new look" },
    ]);
  });

  it("does not run on a mention of the account when mention text is set", async () => {
    const parsed = await channel({ mentionText: "@georgi-ai" }).parse(
      request(
        forwarded({
          body: "hey",
          "m.mentions": { user_ids: ["@me:example.org"] },
        }),
      ),
    );

    expect(parsed.kind).toBe("context");
  });

  it("runs on a mention of the account when no mention text is set", async () => {
    const parsed = await channel().parse(
      request(
        forwarded({
          body: "hey",
          "m.mentions": { user_ids: ["@me:example.org"] },
        }),
      ),
    );

    expect(parsed.kind).toBe("message");
  });

  it("keeps a command bare so it still parses", async () => {
    const parsed = await channel({ mentionText: "@georgi-ai" }).parse(
      request(forwarded({ body: "@georgi-ai /new" })),
    );

    expect(messageOf(parsed).content).toEqual([{ type: "text", text: "/new" }]);
  });

  it("ignores its own replies, edits and rooms outside the allow list", async () => {
    const adapter = channel({ allowedChannelIds: new Set([ROOM_ID]) });

    expect(
      (
        await adapter.parse(
          request(forwarded({ body: "hi", [MATRIX_BOT_MARKER]: true })),
        )
      ).kind,
    ).toBe("ignore");
    expect(
      (
        await adapter.parse(
          request(
            forwarded({
              body: "* hi",
              "m.relates_to": { event_id: "$event-0", rel_type: "m.replace" },
            }),
          ),
        )
      ).kind,
    ).toBe("ignore");
    expect(
      (
        await adapter.parse(
          request(
            forwarded({ body: "hi" }, { roomId: "!elsewhere:example.org" }),
          ),
        )
      ).kind,
    ).toBe("ignore");
  });

  it("strips the quoted fallback from a reply", async () => {
    const parsed = await channel().parse(
      request(
        forwarded({
          body: "> <@me:example.org> old message\n\nnew answer",
          "m.relates_to": { "m.in_reply_to": { event_id: "$event-0" } },
        }),
      ),
    );

    expect(messageOf(parsed).content).toEqual([
      { type: "text", text: "Georgi: new answer" },
    ]);
  });

  it("keys a thread to its own conversation under the room's scope", async () => {
    const parsed = await channel().parse(
      request(
        forwarded({
          body: "in thread",
          "m.relates_to": { event_id: "$root", rel_type: "m.thread" },
        }),
      ),
    );
    const message = messageOf(parsed);

    expect(message.conversationKey).toBe(`matrix:${ROOM_ID}:$root`);
    expect(message.source).toMatchObject({ threadRootId: "$root" });
    expect(channelScopeKeyFromConversation(message.conversationKey)).toBe(
      `matrix:${ROOM_ID}`,
    );
  });

  it("reads and decrypts an encrypted attachment only when asked", async () => {
    const plaintext = Buffer.from("voice note bytes");
    const encrypted = await encryptForTest(plaintext);
    const requested: string[] = [];
    globalThis.fetch = (async (
      input: string | URL | Request,
    ): Promise<Response> => {
      requested.push(String(input));

      return new Response(encrypted.ciphertext);
    }) as typeof fetch;

    const parsed = await channel().parse(
      request(
        forwarded(
          {
            body: "voice.ogg",
            file: { ...encrypted.file, url: "mxc://example.org/media-1" },
            info: { mimetype: "audio/ogg", size: plaintext.byteLength },
            msgtype: "m.audio",
          },
          { encrypted: true },
        ),
      ),
    );
    const attachment = messageOf(parsed).attachments?.[0];

    expect(requested).toEqual([]);
    expect(attachment).toMatchObject({
      mimeType: "audio/ogg",
      name: "voice.ogg",
      type: "audio",
    });
    expect(
      Buffer.from((await attachment!.fetchData!()) as Buffer).toString(),
    ).toBe("voice note bytes");
    expect(requested).toEqual([
      `${API_URL}/_matrix/client/v1/media/download/example.org/media-1`,
    ]);
  });
});

describe("matrix channel actions", () => {
  it("sends a reply through the forwarder with the profile and marker", async () => {
    const sent = captureForwarder();
    const actions = createMatrixActions(API_URL, TOKEN, source(), "Georgi");

    await actions.sendText("**done**");

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("http://forwarder.test/v1/send");
    expect(sent[0]!.token).toBe(TOKEN);
    expect(sent[0]!.body).toMatchObject({
      content: {
        body: "Georgi: **done**",
        "com.beeper.per_message_profile": {
          displayname: "Georgi",
          has_fallback: true,
        },
        "m.relates_to": { "m.in_reply_to": { event_id: "$event-1" } },
        msgtype: "m.text",
        [MATRIX_BOT_MARKER]: true,
      },
      roomId: ROOM_ID,
      type: "m.room.message",
    });
  });

  it("hangs a file it sends off the message it answers", async () => {
    const sent = captureForwarder();
    const actions = createMatrixActions(API_URL, TOKEN, source(), "Georgi");

    await actions.sendFiles!([
      {
        fetchData: (): Promise<Buffer> => Promise.resolve(Buffer.from("notes")),
        mimeType: "text/plain",
        name: "notes.txt",
        type: "file",
        url: "https://example.org/notes.txt",
      },
    ]);

    expect(sent.at(-1)!.body).toMatchObject({
      content: {
        filename: "notes.txt",
        "m.relates_to": { "m.in_reply_to": { event_id: "$event-1" } },
        msgtype: "m.file",
        url: "mxc://example.org/media",
      },
      type: "m.room.message",
    });
  });

  it("reacts to the inbound message", async () => {
    const sent = captureForwarder();

    await createMatrixActions(
      API_URL,
      TOKEN,
      source(),
      undefined,
    ).reactToMessage();

    expect(sent[0]!.body).toMatchObject({
      content: {
        "m.relates_to": {
          event_id: "$event-1",
          key: "👀",
          rel_type: "m.annotation",
        },
      },
      type: "m.reaction",
    });
  });
});

function captureForwarder(): CapturedCall[] {
  process.env.MATRIX_FORWARDER_URL = "http://forwarder.test";
  const calls: CapturedCall[] = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const body = init?.body;
    calls.push({
      // Forwarder calls carry JSON; a media upload carries the bytes.
      body: typeof body === "string" ? JSON.parse(body) : body,
      token: new Headers(init?.headers).get(MATRIX_ACCESS_TOKEN_HEADER),
      url: String(input),
    });

    return Response.json({
      content_uri: "mxc://example.org/media",
      eventId: "$sent",
    });
  }) as typeof fetch;

  return calls;
}

function channel(options: Partial<MatrixChannelOptions> = {}): ChannelAdapter {
  return createMatrixChannel(API_URL, TOKEN, {
    allowedChannelIds: null,
    allowedUserIds: null,
    ...options,
  });
}

async function encryptForTest(
  plaintext: Buffer,
): Promise<{ ciphertext: Buffer; file: Record<string, unknown> }> {
  const key = await crypto.subtle.generateKey(
    { length: 256, name: "AES-CTR" },
    true,
    ["encrypt"],
  );
  const iv = new Uint8Array(16);
  crypto.getRandomValues(iv.subarray(0, 8));
  const ciphertext = Buffer.from(
    await crypto.subtle.encrypt(
      { counter: iv, length: 64, name: "AES-CTR" },
      key,
      new Uint8Array(plaintext),
    ),
  );
  const jwk = await crypto.subtle.exportKey("jwk", key);
  const digest = Buffer.from(
    await crypto.subtle.digest("SHA-256", new Uint8Array(ciphertext)),
  );

  return {
    ciphertext: ciphertext,
    file: {
      hashes: { sha256: digest.toString("base64").replace(/=+$/, "") },
      iv: Buffer.from(iv).toString("base64").replace(/=+$/, ""),
      key: {
        alg: "A256CTR",
        ext: true,
        k: jwk.k,
        key_ops: ["encrypt", "decrypt"],
        kty: "oct",
      },
      v: "v2",
    },
  };
}

function forwarded(
  content: Record<string, unknown>,
  overrides: Partial<Pick<MatrixForwardedEvent, "encrypted" | "roomId">> = {},
): MatrixForwardedEvent {
  return {
    encrypted: overrides.encrypted ?? false,
    event: {
      content: { msgtype: "m.text", ...content },
      event_id: "$event-1",
      origin_server_ts: 1_700_000_000_000,
      sender: "@georgi:example.org",
      type: "m.room.message",
    },
    roomId: overrides.roomId ?? ROOM_ID,
    senderName: "Georgi",
    type: "MATRIX_ROOM_EVENT",
    userId: "@me:example.org",
  };
}

function messageOf(parsed: ChannelParseResult): InboundMessage {
  if (parsed.kind !== "message" && parsed.kind !== "context") {
    throw new Error(`Expected a message, got ${parsed.kind}`);
  }

  return parsed.message;
}

function request(
  payload: MatrixForwardedEvent,
  token: string = TOKEN,
): ChannelRequest {
  return {
    body: JSON.stringify(payload),
    headers: { [MATRIX_ACCESS_TOKEN_HEADER]: token },
    method: "POST",
    rawPath: "/v1/webhooks/acct/matrix",
    rawQueryString: "",
  };
}

function source(): MatrixSource {
  return {
    encrypted: false,
    messageId: "$event-1",
    roomId: ROOM_ID,
    userId: "@georgi:example.org",
  };
}
