/**
 * Upload-time execution-tier classification for account tool bundles.
 * Covers the isolate/sandbox split, the guarded-`process`-probe carve-out, and
 * the per-tier size bound that classification decides.
 */

import { describe, expect, it } from "bun:test";
import {
  inferAccountToolRuntime,
  normalizeAccountToolUpload,
} from "../src/shared/domain/account-tools.ts";

const MAX_ISOLATE_BUNDLE_BYTES = 1_000_000;
const MAX_SANDBOX_BUNDLE_BYTES = 10_000_000;

// n ASCII bytes of isolate-safe source (a comment) for exact-boundary checks.
const bundleOfBytes = (n: number): string => "//" + "a".repeat(n - 2);

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

describe("per-tier bundle size bound", () => {
  it("holds an isolate bundle to the tighter bound", () => {
    expect(() => upload(bundleOfBytes(MAX_ISOLATE_BUNDLE_BYTES))).not.toThrow();
    expect(() => upload(bundleOfBytes(MAX_ISOLATE_BUNDLE_BYTES + 1))).toThrow(
      `tool.bundle must be ${MAX_ISOLATE_BUNDLE_BYTES} bytes or smaller on the isolate runtime`,
    );
  });

  it("gives a sandbox bundle the larger bound", () => {
    // A sandbox bundle streams from S3 into the runner instead of being inlined
    // into core's process, so the isolate's memory argument does not apply.
    const sandbox = (bytes: number): string =>
      `${bundleOfBytes(bytes)}\nimport "node:fs";`;

    expect(() => upload(sandbox(MAX_ISOLATE_BUNDLE_BYTES + 1))).not.toThrow();
    expect(() => upload(sandbox(MAX_SANDBOX_BUNDLE_BYTES + 1))).toThrow(
      `tool.bundle must be ${MAX_SANDBOX_BUNDLE_BYTES} bytes or smaller on the sandbox runtime`,
    );
  });

  it("bounds a bundle-only PATCH by the stored tier, not the inferred one", () => {
    // A PATCH does not restate runtime, so the stored tier is the real one:
    // inferring here would let a multi-MB pure-JS bundle onto the isolate tier.
    const pure = bundleOfBytes(MAX_ISOLATE_BUNDLE_BYTES + 1);

    expect(() => patch(pure, "sandbox")).not.toThrow();
    expect(() => patch(pure, "isolate")).toThrow(
      `tool.bundle must be ${MAX_ISOLATE_BUNDLE_BYTES} bytes or smaller on the isolate runtime`,
    );
  });
});

function patch(bundle: string, currentRuntime: "isolate" | "sandbox"): unknown {
  return normalizeAccountToolUpload(
    { bundle: bundle },
    { requireBundle: false, currentRuntime: currentRuntime },
  );
}

function upload(bundle: string): unknown {
  return normalizeAccountToolUpload(
    {
      name: "sized",
      description: "Sized.",
      inputSchema: { type: "object" },
      bundle: bundle,
    },
    { requireBundle: true },
  );
}
