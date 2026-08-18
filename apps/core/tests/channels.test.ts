/**
 * Shared channel helper tests.
 * Cover shared content extraction and the reach gate here.
 */

import { describe, expect, it } from "bun:test";
import type { UserContent } from "ai";
import { extractText, isAllowedId } from "../src/shared/channels.ts";

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

  it("lets every id through when there is no list or the list is the wildcard", () => {
    expect(isAllowedId(null, "C1")).toBe(true);
    expect(isAllowedId(undefined, "C1")).toBe(true);
    expect(isAllowedId(new Set(["*"]), "C1")).toBe(true);
    expect(isAllowedId(new Set(["*"]), undefined)).toBe(true);
  });

  it("admits listed ids and drops the rest", () => {
    const allowed = new Set(["C1", "C2"]);

    expect(isAllowedId(allowed, "C1")).toBe(true);
    expect(isAllowedId(allowed, "C3")).toBe(false);
  });

  it("drops an id the payload never carried, and an empty list reaches nowhere", () => {
    expect(isAllowedId(new Set(["C1"]), undefined)).toBe(false);
    expect(isAllowedId(new Set(), "C1")).toBe(false);
  });
});
