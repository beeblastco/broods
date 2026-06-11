/**
 * Environment and logging helper tests.
 * Cover env lookup behavior and structured log emission here.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { booleanEnv, optionalEnv, requireEnv } from "../functions/_shared/env.ts";
import { logError, logInfo, logWarn } from "../functions/_shared/log.ts";

const ORIGINAL_ENV = { ...process.env };
const REAL_DATE = Date;
const FIXED_TIME = "2024-01-02T03:04:05.678Z";

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.stdout.write = ORIGINAL_WRITE;
  globalThis.Date = REAL_DATE;
});

const ORIGINAL_WRITE = process.stdout.write.bind(process.stdout);

describe("environment helpers", () => {
  it("returns required environment variables when present", () => {
    process.env.REQUIRED_SAMPLE = "configured";

    expect(requireEnv("REQUIRED_SAMPLE")).toBe("configured");
  });

  it("throws when required environment variables are missing or empty", () => {
    delete process.env.MISSING_SAMPLE;
    process.env.EMPTY_SAMPLE = "";

    expect(() => requireEnv("MISSING_SAMPLE")).toThrow(
      "Missing required environment variable: MISSING_SAMPLE",
    );
    expect(() => requireEnv("EMPTY_SAMPLE")).toThrow(
      "Missing required environment variable: EMPTY_SAMPLE",
    );
  });

  it("returns undefined for optional variables when missing or empty", () => {
    delete process.env.OPTIONAL_SAMPLE;
    process.env.EMPTY_OPTIONAL_SAMPLE = "";
    process.env.SET_OPTIONAL_SAMPLE = "value";

    expect(optionalEnv("OPTIONAL_SAMPLE")).toBeUndefined();
    expect(optionalEnv("EMPTY_OPTIONAL_SAMPLE")).toBeUndefined();
    expect(optionalEnv("SET_OPTIONAL_SAMPLE")).toBe("value");
  });

  it("returns default value when boolean env var is unset", () => {
    delete process.env.BOOL_UNSET;

    expect(booleanEnv("BOOL_UNSET")).toBe(false);
    expect(booleanEnv("BOOL_UNSET", true)).toBe(true);
    expect(booleanEnv("BOOL_UNSET", false)).toBe(false);
  });

  it("returns false when boolean env var is empty", () => {
    process.env.BOOL_EMPTY = "";

    expect(booleanEnv("BOOL_EMPTY")).toBe(false);
  });

  it("parses true-like boolean values case-insensitively with trimming", () => {
    process.env.BOOL_1 = "1";
    process.env.BOOL_TRUE = "true";
    process.env.BOOL_YES = "yes";
    process.env.BOOL_ON = "on";
    process.env.BOOL_UPPER = "TRUE";
    process.env.BOOL_MIXED = "Yes";
    process.env.BOOL_SPACED = "  ON  ";

    expect(booleanEnv("BOOL_1")).toBe(true);
    expect(booleanEnv("BOOL_TRUE")).toBe(true);
    expect(booleanEnv("BOOL_YES")).toBe(true);
    expect(booleanEnv("BOOL_ON")).toBe(true);
    expect(booleanEnv("BOOL_UPPER")).toBe(true);
    expect(booleanEnv("BOOL_MIXED")).toBe(true);
    expect(booleanEnv("BOOL_SPACED")).toBe(true);
  });

  it("parses false-like boolean values case-insensitively with trimming", () => {
    process.env.BOOL_0 = "0";
    process.env.BOOL_FALSE = "false";
    process.env.BOOL_NO = "no";
    process.env.BOOL_OFF = "off";
    process.env.BOOL_UPPER_FALSE = "FALSE";
    process.env.BOOL_MIXED_NO = "No";
    process.env.BOOL_SPACED_OFF = "  off  ";

    expect(booleanEnv("BOOL_0")).toBe(false);
    expect(booleanEnv("BOOL_FALSE")).toBe(false);
    expect(booleanEnv("BOOL_NO")).toBe(false);
    expect(booleanEnv("BOOL_OFF")).toBe(false);
    expect(booleanEnv("BOOL_UPPER_FALSE")).toBe(false);
    expect(booleanEnv("BOOL_MIXED_NO")).toBe(false);
    expect(booleanEnv("BOOL_SPACED_OFF")).toBe(false);
  });

  it("throws on invalid boolean-like values", () => {
    process.env.BOOL_INVALID = "maybe";
    process.env.BOOL_INVALID_NUM = "2";
    process.env.BOOL_INVALID_YEP = "yep";

    expect(() => booleanEnv("BOOL_INVALID")).toThrow("BOOL_INVALID must be a boolean-like value");
    expect(() => booleanEnv("BOOL_INVALID_NUM")).toThrow("BOOL_INVALID_NUM must be a boolean-like value");
    expect(() => booleanEnv("BOOL_INVALID_YEP")).toThrow("BOOL_INVALID_YEP must be a boolean-like value");
  });
});

describe("logging helpers", () => {
  it("emits structured JSON log lines with fixed timestamps", () => {
    const lines: string[] = [];

    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;

    globalThis.Date = class extends REAL_DATE {
      constructor(value?: string | number | Date) {
        super(value ?? FIXED_TIME);
      }

      override toISOString() {
        return FIXED_TIME;
      }

      static override now() {
        return new REAL_DATE(FIXED_TIME).valueOf();
      }
    } as DateConstructor;

    logInfo("started", { requestId: "req-1" });
    logWarn("retrying");
    logError("failed", { code: 500 });

    expect(lines).toHaveLength(3);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        time: FIXED_TIME,
        level: "INFO",
        message: "started",
        requestId: "req-1",
      },
      {
        time: FIXED_TIME,
        level: "WARN",
        message: "retrying",
      },
      {
        time: FIXED_TIME,
        level: "ERROR",
        message: "failed",
        code: 500,
      },
    ]);
  });
});
