/**
 * Upload-time execution-tier classification for account tool bundles.
 * Guards the boundary between the in-core V8 isolate tier and the deferred
 * sandbox tier, including the guarded-`process`-probe carve-out.
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

  // Bundlers inline libraries (zod, the AI SDK) that feature-detect Node through
  // a namespace object. That access is guarded and falls through in an isolate,
  // so it must not push an otherwise pure bundle onto the sandbox tier.
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
