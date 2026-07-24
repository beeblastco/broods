/**
 * Upload-time execution-tier classification for account tool bundles.
 * Covers the isolate/sandbox split and the guarded-`process`-probe carve-out.
 */

import { describe, expect, it } from "bun:test";
import { inferAccountToolRuntime } from "../src/shared/domain/account-tools.ts";

describe("inferAccountToolRuntime", () => {
  it("classifies pure-compute bundles as isolate", () => {
    expect(
      inferAccountToolRuntime(
        "export default { name: 'echo', execute(ctx, input) { return input; } };",
      ),
    ).toBe("isolate");
    expect(
      inferAccountToolRuntime(
        "import { helper } from './helper.js';\nexport default { execute: () => helper() };",
      ),
    ).toBe("isolate");
    expect(
      inferAccountToolRuntime(
        "export default { async execute(ctx, i) { return (await ctx.fetch(i.url)).json(); } };",
      ),
    ).toBe("isolate");
  });

  it("classifies Node-only bundles as sandbox", () => {
    expect(inferAccountToolRuntime("const k = process.env.API_KEY;")).toBe(
      "sandbox",
    );
    expect(inferAccountToolRuntime("process.exit(1);")).toBe("sandbox");
    // `?.` does not guard an unbound identifier — this still throws in an isolate.
    expect(inferAccountToolRuntime("const k = process?.env?.API_KEY;")).toBe(
      "sandbox",
    );
    // A bare `process` reference throws before any `.`/`?.` — cover the plain
    // and bracket-access shapes that a dotted-only probe would miss.
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
    expect(inferAccountToolRuntime("const here = __dirname;")).toBe("sandbox");
  });

  // Bundlers inline libraries (zod, the AI SDK) that probe Node through a
  // namespace object; that access is guarded, so it must not force sandbox.
  it("keeps guarded process probes on the isolate tier", () => {
    expect(
      inferAccountToolRuntime(
        "const g = globalThis;\n" +
          "const rt = g.process?.versions?.node\n" +
          "  ? `runtime/node.js/${globalThis.process.version}`\n" +
          "  : 'runtime/edge';\n" +
          "export default { execute: () => rt };",
      ),
    ).toBe("isolate");
    expect(
      inferAccountToolRuntime("const v = globalThisAny?.process.version;"),
    ).toBe("isolate");
    // Unguarded namespaced access stays isolate too — a stricter rule would break
    // the guarded probes above and bundler-inlined conditional probes.
    expect(inferAccountToolRuntime("const k = globalThis.process.env;")).toBe(
      "isolate",
    );
  });

  it("still flags a bare process global next to other statements", () => {
    expect(inferAccountToolRuntime("init();process.env.TOKEN;")).toBe(
      "sandbox",
    );
    expect(
      inferAccountToolRuntime(
        "const v = globalThis.process.version;\nconst k = process.env.KEY;",
      ),
    ).toBe("sandbox");
  });
});
