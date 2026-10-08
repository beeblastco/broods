import { describe, expect, test } from "bun:test";
import {
  effectiveWindow,
  parseQuery,
  splitQueryChips,
  volumeBins,
} from "../app/lib/queryTokens";

const FIELDS = ["level", "source"] as const;

describe("parseQuery", () => {
  test("lowercases, keeps known tokens and leaves the rest as text", () => {
    expect(parseQuery("  Level:ERROR foo:bar  hello source: ", FIELDS)).toEqual(
      {
        fields: [{ field: "level", value: "error" }],
        text: "foo:bar hello",
      },
    );
  });
});

describe("splitQueryChips", () => {
  test("a token followed by a space is a chip, the tail stays text", () => {
    expect(splitQueryChips("level:error source:gw time", FIELDS)).toEqual({
      chips: ["level:error", "source:gw"],
      text: "time",
    });
  });

  test("extra spaces between chips are whitespace, not text", () => {
    expect(splitQueryChips("level:error  source:gw tail", FIELDS)).toEqual({
      chips: ["level:error", "source:gw"],
      text: "tail",
    });
  });

  test("a token still being typed, or after free text, is not a chip", () => {
    expect(splitQueryChips("level:err", FIELDS)).toEqual({
      chips: [],
      text: "level:err",
    });
    expect(splitQueryChips("hello level:error ", FIELDS)).toEqual({
      chips: [],
      text: "hello level:error ",
    });
    expect(splitQueryChips("level: foo", FIELDS)).toEqual({
      chips: [],
      text: "level: foo",
    });
  });

  test("a quoted value is one chip", () => {
    expect(splitQueryChips('level:"not yet" source:gw tail', FIELDS)).toEqual({
      chips: ['level:"not yet"', "source:gw"],
      text: "tail",
    });
    expect(parseQuery('Level:"Not Yet" x', FIELDS)).toEqual({
      fields: [{ field: "level", value: "not yet" }],
      text: "x",
    });
  });

  test("chips round-trip through the joined query", () => {
    const { chips, text } = splitQueryChips("level:error tail", FIELDS);
    expect(`${chips.join(" ")} ${text}`).toBe("level:error tail");
  });
});

describe("volumeBins", () => {
  test("counts points into equal bins with their severity; newer ones join the last", () => {
    const bins = volumeBins(
      [
        { ts: -1, severity: "error" },
        { ts: 0, severity: "none" },
        { ts: 5, severity: "error" },
        { ts: 9, severity: "warn" },
        { ts: 10, severity: "none" },
        { ts: 11, severity: "none" },
      ],
      { from: 0, to: 10 },
      2,
    );
    expect(bins).toEqual([
      { start: 0, total: 1, error: 0, warn: 0 },
      { start: 5, total: 4, error: 1, warn: 1 },
    ]);
  });
});

describe("effectiveWindow", () => {
  test("is the selection, else the preset with an open end", () => {
    expect(effectiveWindow({ from: 1, to: 2 }, "1h", 100)).toEqual({
      from: 1,
      to: 2,
    });
    expect(effectiveWindow(null, "1h", 3_600_000 * 2)).toEqual({
      from: 3_600_000,
      to: Number.POSITIVE_INFINITY,
    });
  });
});
