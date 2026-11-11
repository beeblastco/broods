import { expect, test } from "bun:test";
import {
  MARKER,
  parseMeasurements,
  renderComment,
} from "./socket-transfer-comment.ts";

const BASE_SHA = "0c42e2dab86ee656f58131822ff37c61a32bc067";

test("only plain path names with two byte counts survive parsing", (): void => {
  const parsed = parseMeasurements(
    JSON.stringify({
      "one trace by id": { bytes: 15_092, ceiling: 18_000, extra: "<img>" },
      "[click](https://example.com)": { bytes: 1, ceiling: 2 },
      "@someone | injected": { bytes: 1, ceiling: 2 },
      "text for bytes": { bytes: "`rm -rf`", ceiling: 2 },
      "negative bytes": { bytes: -1, ceiling: 2 },
      "fraction of a byte": { bytes: 1.5, ceiling: 2 },
      "no ceiling": { bytes: 1 },
      "bare number": 7,
    }),
  );

  expect([...parsed]).toEqual([
    ["one trace by id", { bytes: 15_092, ceiling: 18_000 }],
  ]);
  expect(parseMeasurements("not json").size).toBe(0);
  expect(parseMeasurements('[{"bytes":1,"ceiling":2}]').size).toBe(0);
  expect(parseMeasurements("null").size).toBe(0);
});

test("the comment compares each path with its base", (): void => {
  const comment = renderComment(
    new Map([
      ["trace list, 100 traces", { bytes: 1_738_000, ceiling: 1_800_000 }],
      ["one trace by id", { bytes: 15_092, ceiling: 18_000 }],
      ["chat answer, 400 deltas", { bytes: 60_000, ceiling: 75_000 }],
      ["a new path", { bytes: 500, ceiling: 600 }],
    ]),
    new Map([
      ["trace list, 100 traces", { bytes: 1_580_000, ceiling: 1_800_000 }],
      ["one trace by id", { bytes: 15_092, ceiling: 18_000 }],
      ["chat answer, 400 deltas", { bytes: 80_000, ceiling: 90_000 }],
      ["a path the run lost", { bytes: 34, ceiling: 100 }],
    ]),
    BASE_SHA,
  );

  expect(comment.startsWith(MARKER)).toBe(true);
  expect(comment).toContain("Base measured at `0c42e2d`.");
  expect(comment).toContain(
    "| trace list, 100 traces | 1,580,000 | 1,738,000 | +10.0% |",
  );
  expect(comment).toContain("| one trace by id | 15,092 | 15,092 | 0.0% |");
  expect(comment).toContain(
    "| chat answer, 400 deltas | 80,000 | 60,000 | -25.0% |",
  );
  expect(comment).toContain("| a new path | n/a | 500 | n/a |");
  expect(comment).toContain(
    "| a path the run lost | 34 | not measured | n/a |",
  );
  expect(comment).toContain("No path is over its ceiling.");
});

test("a missing base and a path over its ceiling are both named", (): void => {
  const comment = renderComment(
    new Map([["one trace by id", { bytes: 18_400, ceiling: 18_000 }]]),
    new Map(),
    "",
  );

  expect(comment).toContain("No numbers were found for the base branch");
  expect(comment).toContain("| one trace by id | n/a | 18,400 | n/a |");
  expect(comment).toContain(
    "Over its ceiling: one trace by id (18,400 of 18,000 bytes).",
  );
});
