/** Upload-time runtime classification and bundle-size limits for account code. */

import { describe, expect, it } from "vitest";
import { normalizeAccountHookUpload } from "../model/accountHooks.ts";
import {
  inferAccountToolRuntime,
  normalizeAccountToolUpload,
} from "../model/accountTools.ts";

const MAX_BUNDLE_BYTES = 1_000_000;

// n ASCII bytes of isolate-safe source (a comment) for exact-boundary checks.
const bundleOfBytes = (n: number): string => "//" + "a".repeat(n - 2);

describe("inferAccountToolRuntime", () => {
  it("keeps pure and guarded-probe bundles on the isolate tier", () => {
    expect(
      inferAccountToolRuntime(
        "export default { execute(input, options) { return input; } };",
      ),
    ).toBe("isolate");
    // Bundlers inline a guarded Node probe (globalThis.process?.x) from libraries
    // like the AI SDK; it falls through in an isolate and must stay isolate.
    expect(
      inferAccountToolRuntime(
        "const g = globalThis;\n" +
          "const rt = g.process?.versions?.node ? 'node' : 'edge';\n" +
          "export default { execute: () => rt };",
      ),
    ).toBe("isolate");
    // Unguarded namespaced access (globalThis.process.env) is left on isolate on
    // purpose: the same shape appears in runtime-guarded probes, so a stricter
    // rule would misclassify globalThisAny?.process.version and conditional ones.
    expect(inferAccountToolRuntime("const k = globalThis.process.env;")).toBe(
      "isolate",
    );
  });

  it("routes Node-only bundles to the sandbox tier", () => {
    expect(inferAccountToolRuntime("const k = process.env.API_KEY;")).toBe(
      "sandbox",
    );
    // `?.` does not guard an unbound identifier — still throws in an isolate.
    expect(inferAccountToolRuntime("const k = process?.env?.API_KEY;")).toBe(
      "sandbox",
    );
    // A bare `process` reference in any form throws before any `.`/`?.` — cover
    // the plain-reference and bracket-access shapes the dotted probe misses.
    expect(inferAccountToolRuntime("const p = process;")).toBe("sandbox");
    expect(inferAccountToolRuntime("const k = process['env'];")).toBe(
      "sandbox",
    );
    expect(inferAccountToolRuntime("import fs from 'node:fs';")).toBe(
      "sandbox",
    );
    expect(inferAccountToolRuntime("const fs = require('fs');")).toBe(
      "sandbox",
    );
    expect(inferAccountToolRuntime("import axios from 'axios';")).toBe(
      "sandbox",
    );
  });
});

describe("bundle-size upload gate", () => {
  it("accepts a tool bundle of exactly the max and rejects one byte over", async () => {
    await expect(
      normalizeAccountToolUpload(
        {
          name: "sized",
          description: "Sized.",
          inputSchema: { type: "object" },
          bundle: bundleOfBytes(MAX_BUNDLE_BYTES),
        },
        { requireBundle: true },
      ),
    ).resolves.toMatchObject({ runtime: "isolate" });

    await expect(
      normalizeAccountToolUpload(
        {
          name: "sized",
          description: "Sized.",
          inputSchema: { type: "object" },
          bundle: bundleOfBytes(MAX_BUNDLE_BYTES + 1),
        },
        { requireBundle: true },
      ),
    ).rejects.toThrow(
      `tool.bundle must be ${MAX_BUNDLE_BYTES} bytes or smaller`,
    );
  });

  it("accepts a hook bundle of exactly the max and rejects one byte over", async () => {
    await expect(
      normalizeAccountHookUpload(
        {
          name: "sized",
          events: ["agent.started"],
          bundle: bundleOfBytes(MAX_BUNDLE_BYTES),
        },
        { requireBundle: true },
      ),
    ).resolves.toMatchObject({ sha256: expect.any(String) });

    await expect(
      normalizeAccountHookUpload(
        {
          name: "sized",
          events: ["agent.started"],
          bundle: bundleOfBytes(MAX_BUNDLE_BYTES + 1),
        },
        { requireBundle: true },
      ),
    ).rejects.toThrow(
      `hook.bundle must be ${MAX_BUNDLE_BYTES} bytes or smaller`,
    );
  });
});
