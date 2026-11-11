import { describe, expect, test } from "bun:test";

import {
  signTerminalToken,
  verifyTerminalToken,
} from "../../../../apps/cloudflare-sandbox/src/terminal-token.ts";

describe("verifyTerminalToken", (): void => {
  test("no API key verifies nothing", async (): Promise<void> => {
    const token = await signTerminalToken("key-for-test", "sbx_1", 2_000);

    expect(await verifyTerminalToken("", token, "sbx_1", 1_000)).toBe(false);
  });

  test("a live token for its own sandbox verifies", async (): Promise<void> => {
    const token = await signTerminalToken("key-for-test", "sbx_1", 2_000);

    expect(
      await verifyTerminalToken("key-for-test", token, "sbx_1", 1_000),
    ).toBe(true);
    expect(
      await verifyTerminalToken("key-for-test", token, "sbx_2", 1_000),
    ).toBe(false);
  });
});
