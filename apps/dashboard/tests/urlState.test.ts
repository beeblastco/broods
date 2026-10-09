import { describe, expect, test } from "bun:test";
import { tabHref } from "../app/lib/navigation";
import {
  LOG_VIEW,
  MAX_QUERY_LENGTH,
  parseAsEpochMs,
  parseAsId,
  parseAsModelKeys,
  parseAsName,
  parseAsQuery,
  parseAsSearch,
  parseAsSort,
  parseAsTraceId,
  timeWindow,
  TRACE_VIEW,
  windowParams,
} from "../app/lib/urlState";

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";

describe("URL params read as absent when they fail their check", () => {
  test("range takes only a preset, else the panel's default", () => {
    expect(LOG_VIEW.range.parse("7d")).toBe("7d");
    expect(LOG_VIEW.range.parse("1y")).toBeNull();
    expect(LOG_VIEW.range.parse("<script>")).toBeNull();
    expect(LOG_VIEW.range.defaultValue).toBe("30d");
    expect(TRACE_VIEW.range.defaultValue).toBe("7d");
  });

  test("search text is capped", () => {
    expect(parseAsQuery.parse("status:error timeout")).toBe(
      "status:error timeout",
    );
    expect(parseAsQuery.parse("a".repeat(MAX_QUERY_LENGTH))).toHaveLength(
      MAX_QUERY_LENGTH,
    );
    expect(parseAsQuery.parse("a".repeat(MAX_QUERY_LENGTH + 1))).toBeNull();
    // An explicit `?q=` is a value, so a list link can clear a remembered search.
    expect(parseAsSearch.parse("")).toBe("");
  });

  test("timestamps are plain safe integers", () => {
    expect(parseAsEpochMs.parse("1760000000000")).toBe(1760000000000);
    for (const bad of [
      "NaN",
      "Infinity",
      "-1",
      "1e12",
      "1.5",
      "0x10",
      "",
      "9".repeat(16),
    ]) {
      expect(parseAsEpochMs.parse(bad)).toBeNull();
    }
  });

  test("ids must have their shape", () => {
    expect(parseAsTraceId.parse(TRACE)).toBe(TRACE);
    expect(parseAsTraceId.parse(TRACE.toUpperCase())).toBeNull();
    expect(parseAsTraceId.parse("0".repeat(32))).toBeNull();
    expect(parseAsTraceId.parse(`${TRACE}0`)).toBeNull();

    const cronId = parseAsId<"crons">();
    expect(cronId.parse("jd7f3k2m9q8w1e4r5t6y7v8h9n0p1a2s")).toBe(
      "jd7f3k2m9q8w1e4r5t6y7v8h9n0p1a2s",
    );
    expect(cronId.parse("jd7f3k2m9q8w1e4r5t6y7u8i9o0p1a2s")).toBeNull();
    expect(cronId.parse("../../etc/passwd")).toBeNull();
    expect(cronId.parse("JD7F3K2M9Q8W1E4R5T6Y")).toBeNull();
    expect(cronId.parse("short")).toBeNull();
  });

  test("names and model keys refuse control characters and overlong values", () => {
    expect(parseAsName.parse("Support on-call")).toBe("Support on-call");
    expect(parseAsName.parse("a\nb")).toBeNull();
    expect(parseAsName.parse("x".repeat(201))).toBeNull();
    expect(
      parseAsModelKeys.parse("anthropic::claude-sonnet-4,openai::gpt-5"),
    ).toEqual(["anthropic::claude-sonnet-4", "openai::gpt-5"]);
    // A bad key drops out; `models=` is an empty pick, not "show all".
    expect(parseAsModelKeys.parse("a,\nb,c")).toEqual(["a", "c"]);
    expect(parseAsModelKeys.parse("")).toEqual([]);
    // Any selection the usage panel can write reads back, however many models.
    expect(
      parseAsModelKeys.parse(Array.from({ length: 60 }, () => "m").join(",")),
    ).toHaveLength(60);
  });

  test("sort takes only a column the list has and a direction", () => {
    const sort = parseAsSort({ name: 0, lastUsed: 0 });
    expect(sort.parse("lastUsed.desc")).toEqual({
      column: "lastUsed",
      dir: "desc",
    });
    expect(sort.parse("secret.asc")).toBeNull();
    expect(sort.parse("__proto__.asc")).toBeNull();
    expect(sort.parse("constructor.asc")).toBeNull();
    expect(sort.parse("name.sideways")).toBeNull();
    expect(sort.parse("name")).toBeNull();
    expect(sort.serialize({ column: "name", dir: "asc" })).toBe("name.asc");
  });
});

describe("timeWindow", () => {
  test("needs from before to, and an absent to is open ended", () => {
    expect(timeWindow(10, 20)).toEqual({ from: 10, to: 20 });
    expect(timeWindow(10, null)).toEqual({
      from: 10,
      to: Number.POSITIVE_INFINITY,
    });
    expect(timeWindow(20, 10)).toBeNull();
    expect(timeWindow(10, 10)).toBeNull();
    expect(timeWindow(null, 20)).toBeNull();
  });

  test("round-trips through its params in whole ms", () => {
    const { from, to } = windowParams({ from: 10.4, to: 20.6 });
    expect([from, to].map((ms) => parseAsEpochMs.serialize(ms ?? 0))).toEqual([
      "10",
      "21",
    ]);
    expect(windowParams({ from: 10, to: Number.POSITIVE_INFINITY })).toEqual({
      from: 10,
      to: null,
    });
    expect(windowParams(null)).toEqual({ from: null, to: null });
  });
});

describe("tabHref", () => {
  test("carries only the stage to another tab, plus the view it opens", () => {
    expect(
      tabHref("/p/dashboard", "tracing", "stage=s1&q=secret&range=1h", {
        trace: TRACE,
      }),
    ).toBe(`/p/dashboard?stage=s1&tab=tracing&trace=${TRACE}`);
    expect(tabHref("/p/dashboard", "usage", "q=x")).toBe(
      "/p/dashboard?tab=usage",
    );
  });
});
