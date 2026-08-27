/**
 * Pancake channel adapter tests.
 * Cover webhook normalization and page-scoped filtering here.
 */

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { InboundMessage } from "../src/shared/channels.ts";
import { createPancakeChannel } from "../src/shared/pancake-channel.ts";

const ORIGINAL_FETCH = globalThis.fetch;

describe("pancake channel adapter", () => {
  beforeEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("normalizes messaging events into page-scoped conversations", async () => {
    const adapter = createPancakeChannel(
      "page-1",
      "page-token",
      "hook-secret",
      null,
      null,
    );
    const parsed = await adapter.parse(
      createPancakeRequest({
        page_id: "page-1",
        event_type: "messaging",
        data: {
          conversation: {
            id: "conversation-1",
            type: "INBOX",
            from: { id: "customer-1", name: "Ada" },
          },
          message: {
            id: "message-1",
            conversation_id: "conversation-1",
            page_id: "page-1",
            message: "hello pancake",
            type: "INBOX",
            from: {
              id: "customer-1",
              name: "Ada",
              page_customer_id: "page-customer-1",
            },
          },
        },
      }),
    );

    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") {
      throw new Error("Expected Pancake message event to be accepted");
    }

    expect(parsed.ack).toEqual({ statusCode: 200 });
    expect(parsed.message.eventId).toBe(
      `pancake:page-1:message-1:${hashText("hello pancake")}`,
    );
    expect(parsed.message.conversationKey).toBe(
      "pancake:page-1:conversation-1",
    );
    expect(parsed.message.channelName).toBe("pancake");
    expect(parsed.message.content).toEqual([
      { type: "text", text: "hello pancake" },
    ]);
    expect(parsed.message.source).toMatchObject({
      pageId: "page-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      messageType: "INBOX",
      fromId: "customer-1",
      fromName: "Ada",
      pageCustomerId: "page-customer-1",
    });
  });

  it("carries comment source fields for comment replies", async () => {
    const adapter = createPancakeChannel(
      "page-1",
      "page-token",
      "hook-secret",
      null,
      null,
    );
    const parsed = await adapter.parse(
      createPancakeRequest({
        page_id: "page-1",
        event_type: "messaging",
        data: {
          conversation: { id: "comment-conversation", type: "COMMENT" },
          message: {
            id: "comment-1",
            conversation_id: "comment-conversation",
            page_id: "page-1",
            message: "price?",
            type: "COMMENT",
            from: {
              id: "customer-1",
              name: "Ada",
              page_customer_id: "page-customer-1",
            },
          },
          post: { id: "post-1" },
        },
      }),
    );

    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") {
      throw new Error("Expected Pancake comment event to be accepted");
    }

    expect(parsed.message.source).toMatchObject({
      messageType: "COMMENT",
      messageId: "comment-1",
      postId: "post-1",
    });
  });

  it("ignores non-message events, wrong pages, empty text, and page-originated messages", async () => {
    const adapter = createPancakeChannel(
      "page-1",
      "page-token",
      "hook-secret",
      null,
      null,
    );

    expect(
      await adapter.parse(
        createPancakeRequest({ event_type: "post", page_id: "page-1" }),
      ),
    ).toEqual({
      kind: "ignore",
    });
    expect(
      await adapter.parse(
        createPancakeRequest(validPayload({ page_id: "page-2" })),
      ),
    ).toEqual({
      kind: "ignore",
    });
    expect(
      await adapter.parse(
        createPancakeRequest(validPayload({ message: { message: "   " } })),
      ),
    ).toEqual({
      kind: "ignore",
    });
    expect(
      await adapter.parse(
        createPancakeRequest(
          validPayload({
            message: { from: { id: "page-1", name: "Page" } },
          }),
        ),
      ),
    ).toEqual({ kind: "ignore" });
    expect(
      await adapter.parse(
        createPancakeRequest(
          validPayload({
            message: { from: { id: "customer-1", name: "Ada" } },
          }),
        ),
      ),
    ).toEqual({ kind: "ignore" });
  });

  it("surfaces conversation tag ids on the parsed source so hooks can filter", async () => {
    const adapter = createPancakeChannel(
      "page-1",
      "page-token",
      "hook-secret",
      null,
      null,
    );

    const parsed = await adapter.parse(
      createPancakeRequest(
        validPayload({
          conversation: { tags: ["order-tag", "pending-tag"] },
        }),
      ),
    );

    if (parsed.kind !== "message") {
      throw new Error("Expected Pancake message event to be accepted");
    }
    expect(parsed.message.source).toMatchObject({
      tagIds: ["order-tag", "pending-tag"],
    });
  });

  it("authenticates only requests carrying the webhook secret query parameter", async () => {
    const adapter = createPancakeChannel(
      "page-1",
      "page-token",
      "hook-secret",
      null,
      null,
    );

    expect(
      await adapter.authenticate(
        createPancakeRequest(validPayload(), "secret=hook-secret"),
      ),
    ).toBe(true);
    expect(
      await adapter.authenticate(
        createPancakeRequest(validPayload(), "secret=wrong-secret"),
      ),
    ).toBe(false);
    expect(
      await adapter.authenticate(
        createPancakeRequest(validPayload(), "secret="),
      ),
    ).toBe(false);
    expect(
      await adapter.authenticate(createPancakeRequest(validPayload(), "")),
    ).toBe(false);
  });

  it("accepts a photo with no message text and carries it as an attachment", async () => {
    const message = await parsePancakeMedia({
      message: "",
      attachments: [
        {
          id: "att-1",
          type: "photo",
          url: "https://content.pancake.vn/1/photo.jpg",
          title: "receipt.jpg",
          mime_type: "image/jpeg",
        },
      ],
    });

    expect(message.attachments).toEqual([
      {
        type: "image",
        url: "https://content.pancake.vn/1/photo.jpg",
        name: "receipt.jpg",
        mimeType: "image/jpeg",
      },
    ]);
  });

  it("reads a video from where Pancake hides its URL, and drops what has no file", async () => {
    const message = await parsePancakeMedia({
      message: "look",
      attachments: [
        {
          id: "att-2",
          type: "video",
          video_data: { url: "https://content.pancake.vn/1/clip.mp4" },
        },
        // A share card arrives in the same array with nothing behind it.
        { id: "att-3", type: "share", url: "https://example.com/article" },
      ],
    });

    expect(message.attachments).toEqual([
      { type: "video", url: "https://content.pancake.vn/1/clip.mp4" },
    ]);
  });

  it("gives two captionless photos different event ids", async () => {
    // The message id repeats across edits, so the event id folds in the content
    // — without the attachments in it the second photo dedupes away as a replay.
    const first = await parsePancakeMedia({
      message: "",
      attachments: [
        { id: "a", type: "photo", url: "https://content.pancake.vn/1/a.jpg" },
      ],
    });
    const second = await parsePancakeMedia({
      message: "",
      attachments: [
        { id: "b", type: "photo", url: "https://content.pancake.vn/1/b.jpg" },
      ],
    });

    expect(first.eventId).not.toBe(second.eventId);
  });

  it("still ignores a message with neither text nor attachments", async () => {
    const adapter = createPancakeChannel(
      "page-1",
      "page-token",
      "secret",
      null,
      null,
    );
    const parsed = await adapter.parse(
      createPancakeRequest(validPayload({ message: { message: "" } })),
    );

    expect(parsed.kind).toBe("ignore");
  });
});

async function parsePancakeMedia(
  message: Record<string, unknown>,
): Promise<InboundMessage> {
  const adapter = createPancakeChannel(
    "page-1",
    "page-token",
    "secret",
    null,
    null,
  );
  const parsed = await adapter.parse(
    createPancakeRequest(validPayload({ message: message })),
  );
  if (parsed.kind !== "message") {
    throw new Error(
      `Expected the Pancake media message to be accepted, got ${parsed.kind}`,
    );
  }

  return parsed.message;
}

function createPancakeRequest(
  payload: Record<string, unknown>,
  rawQueryString = "",
) {
  return {
    method: "POST",
    rawPath: "/",
    rawQueryString: rawQueryString,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
}

function validPayload(
  overrides: {
    page_id?: string;
    conversation?: Record<string, unknown>;
    message?: Record<string, unknown>;
  } = {},
) {
  return {
    page_id: overrides.page_id ?? "page-1",
    event_type: "messaging",
    data: {
      conversation: {
        id: "conversation-1",
        type: "INBOX",
        tags: [],
        ...overrides.conversation,
      },
      message: {
        id: "message-1",
        conversation_id: "conversation-1",
        page_id: overrides.page_id ?? "page-1",
        message: "hello",
        type: "INBOX",
        from: {
          id: "customer-1",
          name: "Ada",
          page_customer_id: "page-customer-1",
        },
        ...overrides.message,
      },
    },
  };
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}
