/**
 * NATS JetStream subject-scheme tests.
 * Cover the pure subject/token helpers; the durable publish/consume path needs a
 * live JetStream server and is exercised by examples/nats-stream.ts.
 */

import { describe, expect, it } from "bun:test";
import { streamResponseSubject, subjectToken } from "../functions/_shared/nats.ts";

describe("nats subject scheme", () => {
  it("encodes a conversationKey into a single NATS-safe subject token", () => {
    const token = subjectToken("api:user.1 / chat*>");
    expect(token).toBe(Buffer.from("api:user.1 / chat*>", "utf8").toString("base64url"));
    // No NATS-reserved characters survive (., *, >, whitespace).
    expect(token).not.toMatch(/[.*>\s]/);
  });

  it("round-trips the conversationKey through the token", () => {
    const key = "api:weird/key.with.dots and spaces";
    expect(Buffer.from(subjectToken(key), "base64url").toString("utf8")).toBe(key);
  });

  it("is conversation-scoped so a reconnecting client shares one subject", () => {
    const first = streamResponseSubject("acct1", "agent1", "conv-1");
    const second = streamResponseSubject("acct1", "agent1", "conv-1");
    expect(first).toBe(second);
    expect(first.startsWith("v1.acct1.agent1.ws.response.")).toBe(true);
  });

  it("produces exactly six tokens so it matches the stream wildcard v1.*.*.ws.response.*", () => {
    const subject = streamResponseSubject("acct1", "agent1", "conv with spaces.and.dots");
    const tokens = subject.split(".");
    expect(tokens).toHaveLength(6);
    expect(tokens.slice(0, 5)).toEqual(["v1", "acct1", "agent1", "ws", "response"]);
  });
});
