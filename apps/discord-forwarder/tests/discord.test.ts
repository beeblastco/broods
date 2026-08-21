import { describe, expect, it } from "bun:test";
import {
  heartbeatIntervalMs,
  HEARTBEAT_MAX_MS,
  HEARTBEAT_MIN_MS,
  resumeGatewayUrl,
} from "../src/discord.ts";

describe("resume host", () => {
  it("rebuilds the gateway hosts Discord names in READY", () => {
    expect(resumeGatewayUrl("wss://gateway.discord.gg")).toBe(
      "wss://gateway.discord.gg",
    );
    expect(resumeGatewayUrl("wss://gateway-us-east1-b.discord.gg")).toBe(
      "wss://gateway-us-east1-b.discord.gg",
    );
    // A path or query on the named host is dropped, not carried through.
    expect(resumeGatewayUrl("wss://gateway.discord.gg/?v=9")).toBe(
      "wss://gateway.discord.gg",
    );
  });

  it("refuses a host that would receive the bot token", () => {
    expect(resumeGatewayUrl("wss://evil.example.com")).toBeNull();
    // The suffix must be a real label boundary, not a string ending.
    expect(resumeGatewayUrl("wss://notdiscord.gg")).toBeNull();
    expect(resumeGatewayUrl("wss://gateway.discord.gg.evil.com")).toBeNull();
    // A deeper name would smuggle a second label past the label pattern.
    expect(resumeGatewayUrl("wss://a.b.discord.gg")).toBeNull();
  });

  it("strips credentials rather than dialling them", () => {
    // `URL` reports the hostname without userinfo, so rebuilding from the label
    // drops it. Pinned because the rebuild is the only thing that does: an
    // allow-list on the raw string would have carried these straight through.
    expect(resumeGatewayUrl("wss://user:pass@gateway.discord.gg")).toBe(
      "wss://gateway.discord.gg",
    );
    expect(resumeGatewayUrl("wss://evil.example.com@gateway.discord.gg")).toBe(
      "wss://gateway.discord.gg",
    );
    // Userinfo must not be a way to smuggle the real host past the suffix check.
    expect(resumeGatewayUrl("wss://gateway.discord.gg@evil.example.com")).toBe(
      null,
    );
  });

  it("refuses anything that is not a bare wss URL", () => {
    expect(resumeGatewayUrl("ws://gateway.discord.gg")).toBeNull();
    expect(resumeGatewayUrl("https://gateway.discord.gg")).toBeNull();
    expect(resumeGatewayUrl("wss://gateway.discord.gg:8443")).toBeNull();
    expect(resumeGatewayUrl("gateway.discord.gg")).toBeNull();
    expect(resumeGatewayUrl("")).toBeNull();
  });
});

describe("heartbeat interval", () => {
  it("passes Discord's own interval through", () => {
    expect(heartbeatIntervalMs(41_250)).toBe(41_250);
  });

  it("clamps a value that would spin or never beat", () => {
    expect(heartbeatIntervalMs(0)).toBe(HEARTBEAT_MIN_MS);
    expect(heartbeatIntervalMs(-1)).toBe(HEARTBEAT_MIN_MS);
    expect(heartbeatIntervalMs(9_999_999)).toBe(HEARTBEAT_MAX_MS);
  });

  it("falls back when the field is missing or not a number", () => {
    expect(heartbeatIntervalMs(undefined)).toBe(HEARTBEAT_MAX_MS);
    expect(heartbeatIntervalMs("41250")).toBe(HEARTBEAT_MAX_MS);
    expect(heartbeatIntervalMs(Number.NaN)).toBe(HEARTBEAT_MAX_MS);
  });
});
