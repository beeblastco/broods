import { describe, expect, it } from "bun:test";
import {
  heartbeatIntervalMs,
  HEARTBEAT_INTERVAL_BOUNDS,
  isDiscordGatewayUrl,
} from "../src/discord.ts";

describe("resume host validation", () => {
  it("accepts the gateway hosts Discord names in READY", () => {
    expect(isDiscordGatewayUrl("wss://gateway.discord.gg")).toBe(true);
    expect(isDiscordGatewayUrl("wss://gateway-us-east1-b.discord.gg")).toBe(
      true,
    );
    expect(isDiscordGatewayUrl("wss://gateway.discord.com")).toBe(true);
  });

  it("refuses a host outside Discord, which would receive the bot token", () => {
    expect(isDiscordGatewayUrl("wss://evil.example.com")).toBe(false);
    // The suffix check must not match a host that merely ends in the string.
    expect(isDiscordGatewayUrl("wss://notdiscord.gg")).toBe(false);
    expect(isDiscordGatewayUrl("wss://discord.gg.evil.com")).toBe(false);
  });

  it("refuses anything that is not a wss URL", () => {
    expect(isDiscordGatewayUrl("ws://gateway.discord.gg")).toBe(false);
    expect(isDiscordGatewayUrl("https://gateway.discord.gg")).toBe(false);
    expect(isDiscordGatewayUrl("gateway.discord.gg")).toBe(false);
    expect(isDiscordGatewayUrl("")).toBe(false);
  });
});

describe("heartbeat interval", () => {
  it("passes Discord's own interval through", () => {
    expect(heartbeatIntervalMs(41_250)).toBe(41_250);
  });

  it("clamps a value that would spin or never beat", () => {
    expect(heartbeatIntervalMs(0)).toBe(HEARTBEAT_INTERVAL_BOUNDS.min);
    expect(heartbeatIntervalMs(-1)).toBe(HEARTBEAT_INTERVAL_BOUNDS.min);
    expect(heartbeatIntervalMs(9_999_999)).toBe(HEARTBEAT_INTERVAL_BOUNDS.max);
  });

  it("falls back when the field is missing or not a number", () => {
    expect(heartbeatIntervalMs(undefined)).toBe(HEARTBEAT_INTERVAL_BOUNDS.max);
    expect(heartbeatIntervalMs("41250")).toBe(HEARTBEAT_INTERVAL_BOUNDS.max);
    expect(heartbeatIntervalMs(Number.NaN)).toBe(HEARTBEAT_INTERVAL_BOUNDS.max);
  });
});
