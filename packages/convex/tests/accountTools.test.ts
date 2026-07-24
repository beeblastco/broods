/** Upload-time execution-tier classification for account tool bundles. */

import { describe, expect, it } from "vitest";
import { inferAccountToolRuntime } from "../model/accountTools.ts";

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
  });

  it("routes Node-only bundles to the sandbox tier", () => {
    expect(inferAccountToolRuntime("const k = process.env.API_KEY;")).toBe(
      "sandbox",
    );
    // `?.` does not guard an unbound identifier — still throws in an isolate.
    expect(inferAccountToolRuntime("const k = process?.env?.API_KEY;")).toBe(
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
