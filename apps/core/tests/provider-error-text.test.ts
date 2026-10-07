import { describe, expect, it } from "bun:test";
import { isContextLengthError, toErrorMessage } from "../src/shared/errors.ts";

describe("toErrorMessage", () => {
  it("takes the message straight off an Error", () => {
    expect(toErrorMessage(new Error("Tool call timed out"))).toBe(
      "Tool call timed out",
    );
  });

  it("reads the message a Responses failure nests under response.error", () => {
    // A Responses stream reports failure as data, so `String(error)` rendered
    // "[object Object]" into the log and the chat, and the reason was lost.
    expect(
      toErrorMessage({
        type: "response.failed",
        sequence_number: 7,
        response: {
          error: {
            code: "server_error",
            message: "The model failed to respond",
          },
        },
      }),
    ).toBe("The model failed to respond (server_error)");
  });

  it("reads the message a nested error chunk puts under error", () => {
    expect(
      toErrorMessage({
        type: "error",
        sequence_number: 3,
        error: { type: "invalid_request_error", message: "Bad reasoning item" },
      }),
    ).toBe("Bad reasoning item");
  });

  it("keeps a flat provider error message as it is", () => {
    expect(
      toErrorMessage({ type: "error", message: "Rate limited", code: "429" }),
    ).toBe("Rate limited (429)");
  });

  it("takes a numeric code, which is the other half of what the SDK sends", () => {
    expect(toErrorMessage({ message: "Rate limited", code: 429 })).toBe(
      "Rate limited (429)",
    );
  });

  it("ignores a message that is not a string", () => {
    expect(toErrorMessage({ message: { text: "nested" } })).toBe(
      '{"message":{"text":"nested"}}',
    );
  });

  it("falls back to JSON so an unknown payload is still readable", () => {
    expect(toErrorMessage({ weird: true })).toBe('{"weird":true}');
    expect(toErrorMessage({ error: { nested: { deep: "hidden" } } })).toBe(
      '{"error":{"nested":{"deep":"hidden"}}}',
    );
  });

  it("passes non-objects through", () => {
    expect(toErrorMessage("plain string")).toBe("plain string");
    expect(toErrorMessage(undefined)).toBe("undefined");
    expect(toErrorMessage(null)).toBe("null");
  });
});

describe("isContextLengthError", () => {
  it("spots each provider's context-window refusal", (): void => {
    expect(
      isContextLengthError(
        "This model's maximum context length is 128000 tokens.",
      ),
    ).toBe(true);
    expect(
      isContextLengthError(
        "prompt is too long: 210000 tokens > 200000 maximum",
      ),
    ).toBe(true);
    expect(
      isContextLengthError(
        "The input token count exceeds the maximum number of tokens allowed",
      ),
    ).toBe(true);
  });

  it("counts a request over the per-minute quota, not a passing rate limit", (): void => {
    // One request bigger than the quota never succeeds until history shrinks;
    // a quota already used up clears on its own and must not compact.
    expect(
      isContextLengthError(
        "Request too large for gpt-4o on tokens per min (TPM): Limit 30000, Requested 31000.",
      ),
    ).toBe(true);
    expect(
      isContextLengthError(
        "Rate limit reached for gpt-4o on tokens per min (TPM): Limit 30000, Used 29000, Requested 2000. Please try again in 2s.",
      ),
    ).toBe(false);
  });
});
