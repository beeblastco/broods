/**
 * Shared channel helper tests.
 * Cover shared content extraction and allow-list parsing here.
 */

import { describe, expect, it } from "bun:test";
import type { UserContent } from "ai";
import { extractText, isOpenAllowList } from "../functions/_shared/channels.ts";

describe("shared channel helpers", () => {
  it("extracts and concatenates only text parts from structured user content", () => {
    const content = [
      { type: "text", text: "alpha" },
      { type: "image", image: new Uint8Array([1, 2, 3]) },
      { type: "text", text: "beta" },
    ] as unknown as UserContent;

    expect(extractText(content)).toBe("alphabeta");
  });

  it("returns plain string content unchanged", () => {
    expect(extractText("hello")).toBe("hello");
  });

  it("treats missing, blank, and case-insensitive open allow lists as open", () => {
    expect(isOpenAllowList(undefined)).toBe(true);
    expect(isOpenAllowList("")).toBe(true);
    expect(isOpenAllowList("   ")).toBe(true);
    expect(isOpenAllowList(" Open ")).toBe(true);
  });

  it("rejects explicit non-open allow-list values", () => {
    expect(isOpenAllowList("123,456")).toBe(false);
    expect(isOpenAllowList("closed")).toBe(false);
  });
});
