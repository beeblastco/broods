/** Upload-time runtime classification and bundle-size limits for account code. */

import { describe, expect, it } from "vitest";
import { normalizeAccountHookUpload } from "../model/accountHooks.ts";
import {
  inferAccountToolRuntime,
  normalizeAccountToolUpload,
  requireFullToolUpload,
} from "../model/accountTools.ts";

const MAX_ISOLATE_BUNDLE_BYTES = 1_000_000;
const MAX_SANDBOX_BUNDLE_BYTES = 10_000_000;

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
    expect(inferAccountToolRuntime("const k = process['env'];")).toBe(
      "sandbox",
    );
    expect(inferAccountToolRuntime("const b = Buffer.from('x');")).toBe(
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
    // The isolate has no Web Streams, so a bundle touching one is routed here
    // rather than left to fail at import time.
    expect(
      inferAccountToolRuntime("class Chunker extends TransformStream {}"),
    ).toBe("sandbox");
  });

  // Bundled zod declares a `process` of its own, as an export-map key and as a
  // method. Naming something `process` is not reading Node's global, and
  // treating it as one taxed every zod-shaped bundle with a Lambda round trip.
  it("does not mistake a locally named process for the global", () => {
    expect(
      inferAccountToolRuntime("var mod = { process: () => process2 };"),
    ).toBe("isolate");
    expect(
      inferAccountToolRuntime("class Encoder { process(schema, params) {} }"),
    ).toBe("isolate");
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
          bundle: bundleOfBytes(MAX_ISOLATE_BUNDLE_BYTES),
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
          bundle: bundleOfBytes(MAX_ISOLATE_BUNDLE_BYTES + 1),
        },
        { requireBundle: true },
      ),
    ).rejects.toThrow(
      `tool.bundle must be ${MAX_ISOLATE_BUNDLE_BYTES} bytes or smaller on the isolate runtime`,
    );
  });

  it("gives the sandbox tier the larger bound", async () => {
    // A sandbox bundle is streamed from S3 into the runner instead of inlined,
    // so it is not held in core's process and gets the bigger allowance.
    const oversizedForIsolate = `${bundleOfBytes(MAX_ISOLATE_BUNDLE_BYTES + 1)}\nimport "node:fs";`;

    await expect(
      normalizeAccountToolUpload(
        {
          name: "sized",
          description: "Sized.",
          inputSchema: { type: "object" },
          bundle: oversizedForIsolate,
        },
        { requireBundle: true },
      ),
    ).resolves.toMatchObject({ runtime: "sandbox" });

    await expect(
      normalizeAccountToolUpload(
        {
          name: "sized",
          description: "Sized.",
          inputSchema: { type: "object" },
          bundle: `${bundleOfBytes(MAX_SANDBOX_BUNDLE_BYTES + 1)}\nimport "node:fs";`,
        },
        { requireBundle: true },
      ),
    ).rejects.toThrow(
      `tool.bundle must be ${MAX_SANDBOX_BUNDLE_BYTES} bytes or smaller on the sandbox runtime`,
    );
  });

  it("accepts a hook bundle of exactly the max and rejects one byte over", async () => {
    await expect(
      normalizeAccountHookUpload(
        {
          name: "sized",
          events: ["agent.started"],
          bundle: bundleOfBytes(MAX_ISOLATE_BUNDLE_BYTES),
        },
        { requireBundle: true },
      ),
    ).resolves.toMatchObject({ sha256: expect.any(String) });

    await expect(
      normalizeAccountHookUpload(
        {
          name: "sized",
          events: ["agent.started"],
          bundle: bundleOfBytes(MAX_ISOLATE_BUNDLE_BYTES + 1),
        },
        { requireBundle: true },
      ),
    ).rejects.toThrow(
      `hook.bundle must be ${MAX_ISOLATE_BUNDLE_BYTES} bytes or smaller`,
    );
  });
});

describe("canvas save path", () => {
  // The canvas has no bundler, so it stores isolate-only source and refuses the
  // rest before this call. It still passes the tier explicitly, because
  // `requireBundle: false` never infers one — a save that stopped sending it
  // would silently keep whatever tier the row already held.
  it("returns the tier and hash for the canvas upload shape", async () => {
    const bundle = "export default { execute: (input) => input };";
    expect(inferAccountToolRuntime(bundle)).toBe("isolate");

    await expect(
      normalizeAccountToolUpload(
        { name: "canvas_tool", bundle: bundle, runtime: "isolate" },
        { requireBundle: false },
      ),
    ).resolves.toMatchObject({
      name: "canvas_tool",
      runtime: "isolate",
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  // What the editor refuses. The classifier is covered above; this pins that the
  // canvas guard reads it for the shapes someone actually types into the editor.
  it("flags editor source that cannot resolve without a bundler", () => {
    for (const source of [
      "import axios from 'axios';\nexport default { execute: () => axios };",
      "const fs = require('fs');",
      "export default { execute: () => process.env.KEY };",
      "export default { execute: () => __dirname };",
    ]) {
      expect(inferAccountToolRuntime(source)).toBe("sandbox");
    }
  });

  it("bounds a partial upload by the tier it was classified onto", async () => {
    await expect(
      normalizeAccountToolUpload(
        {
          name: "canvas_tool",
          bundle: bundleOfBytes(MAX_ISOLATE_BUNDLE_BYTES + 1),
          runtime: "isolate",
        },
        { requireBundle: false },
      ),
    ).rejects.toThrow(
      `tool.bundle must be ${MAX_ISOLATE_BUNDLE_BYTES} bytes or smaller on the isolate runtime`,
    );
  });
});

describe("http tier", () => {
  const httpCreate = {
    name: "lookup",
    description: "Looks things up.",
    inputSchema: { type: "object" },
    runtime: "http" as const,
    endpointUrl: "https://api.example.com/lookup",
  };

  // A create carries no bundle at all: no hash, no S3 key, and headers default
  // to an empty set so the executor always has a record to send.
  it("normalizes an endpoint tool without bundle fields", async () => {
    await expect(
      normalizeAccountToolUpload(httpCreate, { requireBundle: true }),
    ).resolves.toEqual({
      name: "lookup",
      description: "Looks things up.",
      inputSchema: { type: "object" },
      runtime: "http",
      endpointUrl: "https://api.example.com/lookup",
      endpointHeaders: {},
    });
  });

  it("keeps declared static headers and trims the URL", async () => {
    await expect(
      normalizeAccountToolUpload(
        {
          ...httpCreate,
          endpointUrl: "  https://api.example.com/lookup  ",
          endpointHeaders: {
            Authorization: "Bearer ${API_TOKEN}",
            "X-Tool-Source": "broods",
          },
        },
        { requireBundle: true },
      ),
    ).resolves.toMatchObject({
      endpointUrl: "https://api.example.com/lookup",
      endpointHeaders: {
        Authorization: "Bearer ${API_TOKEN}",
        "X-Tool-Source": "broods",
      },
    });
  });

  it("rejects the tiers mixing", async () => {
    await expect(
      normalizeAccountToolUpload(
        { ...httpCreate, bundle: "export default {};" },
        { requireBundle: true },
      ),
    ).rejects.toThrow("tool.bundle must not be set for http tools");

    await expect(
      normalizeAccountToolUpload(
        {
          name: "bundled",
          description: "Bundled.",
          inputSchema: { type: "object" },
          bundle: "export default {};",
          runtime: "isolate",
          endpointUrl: "https://api.example.com/x",
        },
        { requireBundle: true },
      ),
    ).rejects.toThrow(
      "tool.endpointUrl and tool.endpointHeaders are only valid for http tools",
    );
  });

  it("requires an https URL", async () => {
    for (const [endpointUrl, message] of [
      ["", "tool.endpointUrl must be a valid URL"],
      ["not a url", "tool.endpointUrl must be a valid URL"],
      ["http://api.example.com/lookup", "tool.endpointUrl must use https"],
      [42, "tool.endpointUrl must be a string"],
      // An http create with the field absent fails the same way — undefined is
      // not a string.
      [undefined, "tool.endpointUrl must be a string"],
    ] as const) {
      await expect(
        normalizeAccountToolUpload(
          { ...httpCreate, endpointUrl: endpointUrl },
          { requireBundle: true },
        ),
      ).rejects.toThrow(message);
    }
  });

  it("bounds the header set", async () => {
    await expect(
      normalizeAccountToolUpload(
        {
          ...httpCreate,
          endpointHeaders: Object.fromEntries(
            Array.from({ length: 33 }, (_, i) => [`X-H${i}`, "v"]),
          ),
        },
        { requireBundle: true },
      ),
    ).rejects.toThrow("tool.endpointHeaders must contain at most 32 headers");

    await expect(
      normalizeAccountToolUpload(
        { ...httpCreate, endpointHeaders: { "Bad Header:": "v" } },
        { requireBundle: true },
      ),
    ).rejects.toThrow("tool.endpointHeaders keys must be header names");

    await expect(
      normalizeAccountToolUpload(
        { ...httpCreate, endpointHeaders: { "X-Token": 7 } },
        { requireBundle: true },
      ),
    ).rejects.toThrow("tool.endpointHeaders.X-Token must be a string");

    await expect(
      normalizeAccountToolUpload(
        {
          ...httpCreate,
          endpointHeaders: { "X-Big": "a".repeat(9 * 1024) },
        },
        { requireBundle: true },
      ),
    ).rejects.toThrow("tool.endpointHeaders must be 8192 bytes or smaller");
  });

  // PATCH semantics: absent means keep. Switching tiers must restate `runtime`
  // explicitly — a bare bundle arriving on a stored http row is rejected rather
  // than silently flipping the row back to a bundled tier.
  it("patches within a tier and switches only with an explicit runtime", async () => {
    await expect(
      normalizeAccountToolUpload(
        { endpointHeaders: { "X-Trace": "1" } },
        { requireBundle: false, currentRuntime: "http" },
      ),
    ).resolves.toEqual({ endpointHeaders: { "X-Trace": "1" } });

    await expect(
      normalizeAccountToolUpload(
        { bundle: "export default {};" },
        { requireBundle: false, currentRuntime: "http" },
      ),
    ).rejects.toThrow("tool.bundle must not be set for http tools");

    const switchedToSandbox = "export default {}; import 'node:fs';";
    await expect(
      normalizeAccountToolUpload(
        { bundle: switchedToSandbox, runtime: "sandbox" },
        { requireBundle: false, currentRuntime: "http" },
      ),
    ).resolves.toMatchObject({
      runtime: "sandbox",
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    await expect(
      normalizeAccountToolUpload(
        { runtime: "http", endpointUrl: "https://api.example.com/v2" },
        { requireBundle: false, currentRuntime: "sandbox" },
      ),
    ).resolves.toEqual({
      runtime: "http",
      endpointUrl: "https://api.example.com/v2",
    });
  });

  it("narrows a full upload for create-path callers", async () => {
    const upload = await normalizeAccountToolUpload(httpCreate, {
      requireBundle: true,
    });
    const full = requireFullToolUpload(upload);
    expect(full.name).toBe("lookup");
    expect(full.description).toBe("Looks things up.");
    expect(full.inputSchema).toEqual({ type: "object" });

    // A PATCH result has no name — the create path must not accept it.
    const patched = await normalizeAccountToolUpload(
      { endpointHeaders: {} },
      { requireBundle: false, currentRuntime: "http" },
    );
    expect(() => requireFullToolUpload(patched)).toThrow();
  });
});
