/**
 * The Workers scan that places hosted MCP bundles: a plain web module goes to
 * Cloudflare, anything that needs Node or code generation goes to Lambda.
 */

import { describe, expect, it } from "vitest";
import { isWorkersSafeBundle } from "../model/isolateSafety";

describe("isWorkersSafeBundle", (): void => {
  it("accepts a web module and refuses what Workers cannot run", (): void => {
    expect(
      isWorkersSafeBundle(
        'import { a } from "./a.js";\nexport default { fetch: () => fetch("https://x.dev") };',
      ),
    ).toBe(true);
    for (const source of [
      'import {\n  readFileSync,\n} from "node:fs";',
      'import { z } from "zod";',
      'const fs = require("fs");',
      'var fs = __require("fs");',
      "export const dir = __dirname;",
      "const key = process.env.KEY;",
      'const f = new Function("return 1");',
      'eval("1");',
    ]) {
      expect(isWorkersSafeBundle(source), source).toBe(false);
    }
  });

  it("scans a multi-MB bundle in linear time", (): void => {
    const filler = "import.meta.url; // import x\n".repeat(200_000);
    const startedAt = performance.now();
    expect(isWorkersSafeBundle(filler + "export default {};")).toBe(true);
    expect(performance.now() - startedAt).toBeLessThan(5_000);
  });
});
