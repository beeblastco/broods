import { defineAgent, defineTool, env } from "broods";
import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";

// No `runtime` here on purpose: the classifier reads the bundle, sees the `node:`
// imports, and routes it to the sandbox tier by itself.
export const systemReportTool = defineTool({
  name: "system_report",
  description:
    "Hashes and compresses a string inside the sandbox runtime, returning the digest, gzip size, and the runner's Node version.",
  inputSchema: {
    type: "object",
    properties: {
      payload: {
        type: "string",
        description: "Text to hash and compress.",
      },
    },
    required: ["payload"],
    additionalProperties: false,
  },
  async execute(input: { payload?: string }) {
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
});

export const sandboxToolAgent = defineAgent({
  name: "sandbox-tool-agent",
  provider: {
    custom: {
      apiKey: env.AI_API_KEY,
      base_url: env.AI_BASE_URL,
    },
  },
  model: {
    provider: "custom",
    modelId: "Qwen3.6-27B",
  },
  agent: {
    system:
      "You are a helpful assistant. When asked, call the system_report tool and report every field it returns.",
  },
  tools: {
    [systemReportTool.name]: {
      enabled: true,
    },
  },
  publicAccess: true,
});
