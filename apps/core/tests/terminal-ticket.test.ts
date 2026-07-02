/**
 * Sandbox terminal ticket sealing/opening — round trip, expiry, tampering, and
 * wrong-secret rejection (the gateway tries each stage secret in turn).
 */

import { describe, expect, test } from "bun:test";
import {
  openTerminalTicket,
  sealTerminalTicket,
  type TerminalTicket,
} from "../functions/_shared/terminal-ticket.ts";

const SECRET = "test-service-secret";

function ticket(overrides: Partial<TerminalTicket> = {}): TerminalTicket {
  return {
    url: "ws://sandbox-node.example:8080/v1/sandboxes/sb_123/pty",
    authorization: "Bearer sk_live_abc",
    accountId: "acct_1",
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

describe("terminal tickets", () => {
  test("round-trips the upstream connection info", () => {
    const sealed = sealTerminalTicket(ticket(), SECRET);
    const opened = openTerminalTicket(sealed, SECRET);
    expect(opened).toEqual(ticket({ expiresAt: opened?.expiresAt }));
    expect(opened?.url).toContain("/pty");
    expect(sealed).not.toContain("sk_live_abc");
  });

  test("round-trips a custom auth header (MicroVM shells use X-aws-proxy-auth)", () => {
    const microvm = ticket({
      url: "wss://mvm-1.lambda-microvm.eu-west-1.on.aws",
      authorization: "jwe-shell-token",
      authorizationHeader: "X-aws-proxy-auth",
    });
    const opened = openTerminalTicket(sealTerminalTicket(microvm, SECRET), SECRET);
    expect(opened).toEqual(microvm);
    // workdir tickets omit the field and keep defaulting to `authorization`.
    expect(openTerminalTicket(sealTerminalTicket(ticket(), SECRET), SECRET)?.authorizationHeader).toBeUndefined();
  });

  test("rejects an expired ticket", () => {
    const sealed = sealTerminalTicket(ticket({ expiresAt: Date.now() - 1 }), SECRET);
    expect(openTerminalTicket(sealed, SECRET)).toBeNull();
  });

  test("rejects the wrong secret without throwing", () => {
    const sealed = sealTerminalTicket(ticket(), SECRET);
    expect(openTerminalTicket(sealed, "other-stage-secret")).toBeNull();
  });

  test("rejects tampered tokens and garbage", () => {
    const sealed = sealTerminalTicket(ticket(), SECRET);
    const [version, iv, tag, ciphertext] = sealed.split(".") as [string, string, string, string];
    const flipped = ciphertext.startsWith("A") ? `B${ciphertext.slice(1)}` : `A${ciphertext.slice(1)}`;
    expect(openTerminalTicket([version, iv, tag, flipped].join("."), SECRET)).toBeNull();
    expect(openTerminalTicket("st1.not.a.ticket", SECRET)).toBeNull();
    expect(openTerminalTicket("", SECRET)).toBeNull();
    expect(openTerminalTicket(`${sealed}.extra`, SECRET)).toBeNull();
  });
});
