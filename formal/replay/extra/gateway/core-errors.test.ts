import { describe, expect, test } from "bun:test";

// Lives under gateway because core's no-network preload loads these modules before the recorder.
import {
  isContextLengthError,
  isTimeoutError,
  isUnreachableError,
  toErrorMessage,
} from "../../../../apps/core/src/shared/errors.ts";
import {
  drainInFlight,
  inFlightForTests,
  waitUntil,
} from "../../../../apps/core/src/shared/in-flight.ts";

class CodedError extends Error {
  code: unknown;

  constructor(code: unknown) {
    super("network");
    this.code = code;
  }
}

function named(name: string): Error {
  const error = new Error("boom");
  error.name = name;

  return error;
}

describe("error classification", () => {
  test.each([
    ["Request too large for gpt", true],
    ["context length exceeded", true],
    ["CONTEXT WINDOW full", true],
    ["prompt is too long", true],
    ["input is too long", true],
    ["exceeds the maximum number of tokens", true],
    ["rate limited", false],
  ])("isContextLengthError(%s)", (message: string, expected: boolean): void => {
    expect(isContextLengthError(message)).toBe(expected);
  });

  test.each([
    [named("TimeoutError"), true],
    [named("AbortError"), false],
    ["TimeoutError", false],
  ])("isTimeoutError %#", (value: unknown, expected: boolean): void => {
    expect(isTimeoutError(value)).toBe(expected);
  });

  test.each([
    [new CodedError("ECONNREFUSED"), true],
    [new CodedError("ENOTFOUND"), true],
    [new CodedError("FailedToOpenSocket"), true],
    [new CodedError("EPIPE"), false],
    [new CodedError(7), false],
    [new Error("plain"), false],
    [{ code: "ECONNREFUSED" }, false],
  ])("isUnreachableError %#", (value: unknown, expected: boolean): void => {
    expect(isUnreachableError(value)).toBe(expected);
  });
});

describe("toErrorMessage", () => {
  test.each([
    [new Error("direct"), "direct"],
    [{ message: "top" }, "top"],
    [{ message: "coded", code: "E1" }, "coded (E1)"],
    [{ message: "numbered", code: 42 }, "numbered (42)"],
    [{ message: "odd code", code: true }, "odd code"],
    [{ message: "" }, '{"message":""}'],
    [{ error: { message: "inner" } }, "inner"],
    [{ response: { error: { message: "deep", code: 9 } } }, "deep (9)"],
    [
      { error: { error: { error: { message: "too deep" } } } },
      '{"error":{"error":{"error":{"message":"too deep"}}}}',
    ],
    [{ error: "text" }, '{"error":"text"}'],
    ["plain string", "plain string"],
    [12, "12"],
    [0, "0"],
    [null, "null"],
    [undefined, "undefined"],
    [false, "false"],
  ])("%#", (value: unknown, expected: string): void => {
    expect(toErrorMessage(value)).toBe(expected);
  });

  test("an unserializable object has a fixed message", (): void => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;

    expect(toErrorMessage(circular)).toBe("Unserializable error");
  });
});

describe("in-flight work", () => {
  test("a tracked promise leaves the set once it settles", async (): Promise<void> => {
    waitUntil(Promise.resolve("done"));

    expect(inFlightForTests().size).toBe(1);
    await drainInFlight();
    expect(inFlightForTests().size).toBe(0);
  });

  test("a failed promise is logged, not raised", async (): Promise<void> => {
    waitUntil(Promise.reject(new Error("post-response")));

    await drainInFlight();
    expect(inFlightForTests().size).toBe(0);
  });

  test("draining with nothing tracked returns at once", async (): Promise<void> => {
    await drainInFlight();
    expect(inFlightForTests().size).toBe(0);
  });
});
