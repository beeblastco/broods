import { describe, expect, test } from "bun:test";
import { formatDuration } from "../app/lib/formatTime";

describe("formatDuration", () => {
  test("picks the unit a span or run row reads best in", () => {
    expect(formatDuration(812)).toBe("812ms");
    expect(formatDuration(4_100)).toBe("4.10s");
    expect(formatDuration(93_000)).toBe("1m 33s");
    expect(formatDuration(7_500_000)).toBe("2h 5m");
  });
});
