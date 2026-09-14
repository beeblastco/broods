import { expect, test } from "bun:test";
import { formatNumber } from "../app/lib/formatNumber";

test("a count rounds into the next unit instead of reading 1000.0K", () => {
  expect(formatNumber(999_949)).toBe("999.9K");
  expect(formatNumber(999_999)).toBe("1.0M");
  expect(formatNumber(999)).toBe("999");
  expect(formatNumber(999.5)).toBe("1.0K");
  expect(formatNumber(48_800)).toBe("48.8K");
});
