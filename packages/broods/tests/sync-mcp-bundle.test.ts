/**
 * Past the inline threshold, putManifest uploads the MCP bundle to a minted
 * URL and syncs bundleStorageId + sha256 (#190); small bundles keep the
 * single-request path byte-for-byte.
 */

import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { BroodsSyncClient } from "../src/sync.ts";

interface SentRequest {
  url: string;
  method: string;
  body: string;
}

function manifestWithBundle(bundle: string) {
  return {
    version: 1 as const,
    project: "demo-app",
    stage: "staging",
    resources: [
      {
        kind: "mcp",
        name: "search",
        config: { bundle: bundle, allowedTools: ["find"] },
      },
    ],
  };
}

function recordingClient() {
  const sent: SentRequest[] = [];
  const client = new BroodsSyncClient({
    baseUrl: "https://convex.example.com",
    token: "tok",
    fetch: async (input, init) => {
      const url = String(input);
      sent.push({
        url: url,
        method: (init?.method ?? "GET").toUpperCase(),
        body: String(init?.body ?? ""),
      });
      if (url.endsWith("/mcp-bundle-uploads")) {
        return new Response(
          JSON.stringify({ uploadUrl: "https://storage.example.com/upload" }),
        );
      }
      if (url === "https://storage.example.com/upload") {
        return new Response(JSON.stringify({ storageId: "st_123" }));
      }

      return new Response(
        JSON.stringify({ manifest: {}, ids: {}, deployment: null }),
      );
    },
  });

  return { client: client, sent: sent };
}

test("a bundle past the inline threshold is uploaded and referenced by storage id", async () => {
  const bundle = `export default () => new Response("${"x".repeat(10_000_001)}")`;
  const { client, sent } = recordingClient();

  await client.putManifest(manifestWithBundle(bundle), false);

  expect(sent.map((request) => request.url)).toEqual([
    "https://convex.example.com/v1/account/projects/demo-app/stages/staging/mcp-bundle-uploads",
    "https://storage.example.com/upload",
    "https://convex.example.com/v1/account/projects/demo-app/stages/staging/manifest",
  ]);
  expect(sent[1]?.body).toBe(bundle);
  const synced = JSON.parse(sent[2]!.body) as {
    manifest: {
      resources: Array<{ config: Record<string, unknown> }>;
    };
  };
  expect(synced.manifest.resources[0]?.config).toEqual({
    allowedTools: ["find"],
    bundleStorageId: "st_123",
    sha256: createHash("sha256").update(bundle).digest("hex"),
  });
});

test("a small bundle stays inline in one request", async () => {
  const bundle = `export default () => new Response("ok")`;
  const { client, sent } = recordingClient();

  await client.putManifest(manifestWithBundle(bundle), false);

  expect(sent).toHaveLength(1);
  expect(sent[0]?.url).toBe(
    "https://convex.example.com/v1/account/projects/demo-app/stages/staging/manifest",
  );
  const synced = JSON.parse(sent[0]!.body) as {
    manifest: { resources: Array<{ config: Record<string, unknown> }> };
  };
  expect(synced.manifest.resources[0]?.config).toEqual({
    bundle: bundle,
    allowedTools: ["find"],
  });
});
