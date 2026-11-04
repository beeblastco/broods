import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import fc from "fast-check";
import type { CliManifestResource } from "../../packages/convex/cli/types.ts";
import { diffManifests } from "../../packages/broods/src/sync.ts";
import { oracleRuns, oracleSeed } from "./oracle-options.ts";

const ORACLE = new URL("../.lake/build/bin/sync-oracle", import.meta.url)
  .pathname;

const KINDS: CliManifestResource["kind"][] = [
  "agent",
  "workspace",
  "sandbox",
  "cron",
  "skill",
  "hook",
  "mcp",
  "policy",
  "channelRecord",
];

// `Broods.Sync.Resource`: names and settings are small numbers, so keys, renames and equal
// configs collide often.
interface Abstract {
  kind: CliManifestResource["kind"];
  name: number;
  settings: number;
  bundle: number | null;
  storage: number | null;
}

const resourceArb = fc.record({
  kind: fc.constantFrom(...KINDS),
  name: fc.nat({ max: 3 }),
  settings: fc.nat({ max: 2 }),
  bundle: fc.option(fc.nat({ max: 1 })),
  storage: fc.option(fc.nat({ max: 1 })),
});

// The model assumes unique manifests (`Manifest.unique`); `diffManifests` keys by kind and name.
const manifestArb = fc.uniqueArray(resourceArb, {
  maxLength: 6,
  selector: (resource) => `${resource.kind}:${resource.name}`,
});

test("diffManifests agrees with the Lean model's diff on generated manifests", () => {
  if (!existsSync(ORACLE)) {
    throw new Error(
      `missing ${ORACLE}: run \`lake build sync-oracle\` in verification/`,
    );
  }
  const cases = fc.sample(fc.tuple(manifestArb, manifestArb), {
    seed: oracleSeed(),
    numRuns: oracleRuns(),
  });
  const oracle = Bun.spawnSync([ORACLE], {
    stdin: Buffer.from(
      cases
        .map(([local, remote]) => `${encode(local)}\t${encode(remote)}\n`)
        .join(""),
    ),
  });
  expect(oracle.exitCode).toBe(0);
  const answers = oracle.stdout.toString().split("\n").slice(0, -1);
  expect(answers).toHaveLength(cases.length);

  const disagreements = cases
    .map(([local, remote], index) => ({
      local: encode(local),
      remote: encode(remote),
      ts: tsDiff(local, remote),
      lean: sorted(answers[index] ?? ""),
    }))
    .filter(({ ts, lean }) => ts !== lean)
    .toSorted(
      (a, b) =>
        a.local.length + a.remote.length - b.local.length - b.remote.length,
    );
  expect(disagreements.slice(0, 5)).toEqual([]);
});

// The concrete resource: every kind carries the artifact keys, so the diff must strip them for
// skills, hooks and MCP servers only.
function concrete(resource: Abstract): CliManifestResource {
  return {
    kind: resource.kind,
    name: `r${resource.name}`,
    config: {
      sha256: `s${resource.settings}`,
      ...(resource.bundle === null ? {} : { bundle: `b${resource.bundle}` }),
      ...(resource.storage === null
        ? {}
        : { bundleStorageId: `st${resource.storage}` }),
    },
  };
}

// `kind:name:settings:bundle:storage` per resource, as `SyncOracle.lean` reads it.
function encode(manifest: Abstract[]): string {
  return manifest
    .map(
      (resource) =>
        `${resource.kind}:${resource.name}:${resource.settings}:${resource.bundle ?? "-"}:${resource.storage ?? "-"}`,
    )
    .join(" ");
}

// Space-separated entries in one order, since the model's diff is unsorted.
function sorted(entries: string): string {
  return entries
    .split(" ")
    .filter((entry) => entry !== "")
    .toSorted()
    .join(" ");
}

// `diffManifests` as `op:kind:name` entries, names back to the model's numbers.
function tsDiff(local: Abstract[], remote: Abstract[]): string {
  const manifest = (
    resources: Abstract[],
  ): Parameters<typeof diffManifests>[0] => ({
    version: 1,
    project: "oracle",
    stage: "development",
    resources: resources.map(concrete),
  });

  return sorted(
    diffManifests(manifest(local), manifest(remote))
      .map(
        (entry) =>
          `${entry.operation}:${entry.kind}:${entry.name.replace(/^r/, "")}`,
      )
      .join(" "),
  );
}
