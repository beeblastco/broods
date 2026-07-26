/**
 * A sandbox-tier tool: it imports `node:` builtins, so the classifier routes it to
 * the tool-runner Lambda instead of the V8 isolate, which has no module surface.
 * Also asserts the containment the runner promises — see the demo README.
 */

import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";

export default {
  name: "system_report",
  async execute(ctx: unknown, input: { payload?: string }) {
    const payload = input.payload ?? "broods sandbox tier";
    const compressed = gzipSync(Buffer.from(payload, "utf8"));

    return {
      // Native modules the isolate tier cannot provide at all.
      sha256: createHash("sha256").update(payload).digest("hex"),
      gzipBytes: compressed.byteLength,
      requestId: randomUUID(),
      nodeVersion: process.version,
      // Containment checks: credentials scrubbed, and no bundle left on disk.
      awsCredentialsVisible: Boolean(process.env.AWS_SECRET_ACCESS_KEY),
      tmpEntries: readdirSync(tmpdir()).length,
    };
  },
};
