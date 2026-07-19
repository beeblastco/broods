/**
 * Generic per-message metadata carriage: a channel.message.received hook's
 * `metadata` return rides the ingress event, persists on the stored-event
 * envelope (never inside the model message), and is stripped again before
 * messages reach a model call. Core carries the value without interpreting it.
 */

import { describe, expect, it } from "bun:test";
import type { ModelMessage } from "ai";
import {
  attachMetadataToLatestUserIngress,
  rewriteLatestUserIngressText,
} from "../src/harness/integrations.ts";
import {
  createStoredEventFromModelMessage,
  stripEnvelopeFieldsFromMessages,
  type ConversationIngressEvent,
} from "../src/harness/session.ts";
import { sanitizeHookResult } from "../src/harness/hook-runner.ts";

const METADATA = { authorId: "U04ABC", name: "Phicks", ts: 1789000000000 };

describe("attachMetadataToLatestUserIngress", () => {
  it("attaches metadata to the newest user event only", () => {
    const events: ConversationIngressEvent[] = [
      { role: "user", content: "earlier" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "latest" },
    ];

    const next = attachMetadataToLatestUserIngress(events, METADATA);

    expect(next[2]).toEqual({
      role: "user",
      content: "latest",
      metadata: METADATA,
    });
    expect(next[0]).toEqual({ role: "user", content: "earlier" });
    // Input list is not mutated.
    expect(events[2]).toEqual({ role: "user", content: "latest" });
  });

  it("returns the list unchanged when there is no user event", () => {
    const events: ConversationIngressEvent[] = [
      { role: "assistant", content: "reply" },
    ];

    expect(attachMetadataToLatestUserIngress(events, METADATA)).toBe(events);
  });

  it("composes with a text rewrite on the same event", () => {
    const events: ConversationIngressEvent[] = [
      { role: "user", content: "raw" },
    ];

    const next = attachMetadataToLatestUserIngress(
      rewriteLatestUserIngressText(events, "rewritten"),
      METADATA,
    );

    expect(next[0]).toEqual({
      role: "user",
      content: "rewritten",
      metadata: METADATA,
    });
  });
});

describe("createStoredEventFromModelMessage", () => {
  it("moves user metadata onto the stored envelope, not the message", () => {
    const stored = createStoredEventFromModelMessage(
      { role: "user", content: "hello", metadata: METADATA } as ModelMessage,
      "evt-1",
    );

    expect(stored).toEqual({
      version: 1,
      sourceEventId: "evt-1",
      metadata: METADATA,
      message: { role: "user", content: "hello" },
    });
  });

  it("omits the metadata key when the message carries none", () => {
    const stored = createStoredEventFromModelMessage(
      { role: "user", content: "hello" },
      "evt-2",
    );

    expect(stored).toEqual({
      version: 1,
      sourceEventId: "evt-2",
      message: { role: "user", content: "hello" },
    });
    expect(stored).not.toHaveProperty("metadata");
  });
});

describe("stripEnvelopeFieldsFromMessages", () => {
  it("removes metadata and createdAt before a model call", () => {
    const messages = [
      {
        role: "user",
        content: "hello",
        metadata: METADATA,
        createdAt: "2026-07-19T10:03:00.000Z",
      } as ModelMessage,
      { role: "assistant", content: "reply" } as ModelMessage,
    ];

    const stripped = stripEnvelopeFieldsFromMessages(messages);

    expect(stripped[0]).toEqual({ role: "user", content: "hello" });
    // Clean messages pass through by reference.
    expect(stripped[1]).toBe(messages[1]);
  });
});

describe("sanitizeHookResult", () => {
  it("keeps metadata for channel.message.received mutations", () => {
    const mutation = sanitizeHookResult("channel.message.received", {
      text: "tagged",
      metadata: METADATA,
      unrelated: "dropped",
    });

    expect(mutation).toEqual({ text: "tagged", metadata: METADATA });
  });
});
