/**
 * NATS subject-scheme + resume-cursor tests.
 * Cover the pure helpers; the core-publish / stream-capture / consume path needs
 * a live JetStream server and is exercised by examples/nats-stream.ts.
 */

import { describe, expect, it } from "bun:test";
import { DeliverPolicy } from "nats.ws";
import { consumerStartPolicy, streamResponseSubject, subjectToken } from "../functions/_shared/nats.ts";

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

describe("consumerStartPolicy (resume cursor)", () => {
  it("resumes by sequence when a JsMsg.seq cursor is given", () => {
    expect(consumerStartPolicy(42)).toEqual({
      deliver_policy: DeliverPolicy.StartSequence,
      opt_start_seq: 42,
    });
  });

  it("resumes by time when only a timestamp is given (core→stream switch)", () => {
    expect(consumerStartPolicy(undefined, "2026-06-05T00:00:00.000Z")).toEqual({
      deliver_policy: DeliverPolicy.StartTime,
      opt_start_time: "2026-06-05T00:00:00.000Z",
    });
  });

  it("replays from the start when no cursor is given", () => {
    expect(consumerStartPolicy()).toEqual({ deliver_policy: DeliverPolicy.All });
  });

  it("prefers the sequence cursor over time when both are given", () => {
    expect(consumerStartPolicy(7, "2026-06-05T00:00:00.000Z")).toEqual({
      deliver_policy: DeliverPolicy.StartSequence,
      opt_start_seq: 7,
    });
  });
});
