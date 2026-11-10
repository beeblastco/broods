// The manifest as `broods diff` compares it, shared by the CLI and the config plane so a stage's
// manifest hash is the same number on both sides.

import { sha256Hex } from "./accountSecrets";
import { stableJson } from "./objects";

// Bytes the server snapshot drops, and an upload handle only it has; sha256 still diffs content.
const ARTIFACT_KEYS: ReadonlySet<string> = new Set([
  "bundle",
  "bundleStorageId",
  "contentBase64",
]);
const ARTIFACT_KINDS: ReadonlySet<string> = new Set(["hook", "mcp", "skill"]);

type SnapshotInput = { kind: string; config: unknown } & Record<
  string,
  unknown
>;

/** sha256 hex of each resource snapshot by `kind:name`: equal exactly when the diff is empty. */
export async function manifestHash(
  resources: readonly SnapshotInput[],
): Promise<string> {
  const entries = resources
    .map((resource): [string, string] => [
      `${resource.kind}:${String(resource.name)}`,
      stableJson(snapshotResource(resource)),
    ])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return await sha256Hex(JSON.stringify(entries));
}

export function snapshotResource(resource: SnapshotInput): unknown {
  const normalized = normalizeEnvRefs(resource) as SnapshotInput;
  if (!ARTIFACT_KINDS.has(resource.kind)) return normalized;

  return { ...normalized, config: stripArtifactContent(normalized.config) };
}

function normalizeEnvRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeEnvRefs);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.__beeblastEnv === true && typeof record.name === "string") {
      return `\${${record.name}}`;
    }

    return Object.fromEntries(
      Object.entries(record).map(([key, entry]) => [
        key,
        normalizeEnvRefs(entry),
      ]),
    );
  }

  return value;
}

function stripArtifactContent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripArtifactContent);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, entry]) => {
        if (ARTIFACT_KEYS.has(key)) return [];

        return [[key, stripArtifactContent(entry)]];
      }),
    );
  }

  return value;
}
