/**
 * When a refused create moves to the fallback provider, and when it must not.
 * The classifier itself is covered beside the executors; this pins the decision.
 */

import { expect, it } from "bun:test";
import { sandboxFallbackFor } from "../src/harness/tools/filesystem-utils.ts";

const quota = Object.assign(new Error("maximum allocated memory limit"), {
  name: "ServiceQuotaExceededException",
});

it("moves an ephemeral run to the fallback provider on a capacity refusal", () => {
  expect(
    sandboxFallbackFor(
      { provider: "lambda", fallbackProvider: "sandbox", timeout: 60 },
      quota,
    ),
  ).toEqual({ provider: "sandbox", timeout: 60 });
});

it("stays put without a fallback, on a persistent config, or on any other error", () => {
  expect(sandboxFallbackFor({ provider: "lambda" }, quota)).toBeNull();
  expect(
    sandboxFallbackFor(
      { provider: "lambda", fallbackProvider: "sandbox", persistent: true },
      quota,
    ),
  ).toBeNull();
  expect(
    sandboxFallbackFor(
      { provider: "lambda", fallbackProvider: "sandbox" },
      new Error("connection reset"),
    ),
  ).toBeNull();
});
