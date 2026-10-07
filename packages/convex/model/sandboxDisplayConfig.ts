/**
 * Display-safe projection of a sandbox config for the canvas layout.
 *
 * Layouts are UI state the dashboard reads back verbatim, so they must never
 * carry `envVars` or provider `options`, which hold credentials. These keys
 * are exactly what the sandbox node and its side panel render: the globe reads
 * `network.mode`, the feature row reads `persistent`, and the config tab edits
 * `provider`, `image`, `snapshot` and `permissionMode`. A key the tab edits but
 * this drops would be wiped from the stored config on the next canvas save.
 */

import { isPlainObject } from "./objects";

const DISPLAY_KEYS = [
  "image",
  "network",
  "permissionMode",
  "persistent",
  "provider",
  "snapshot",
] as const;

export function sandboxDisplayConfig(config: unknown): Record<string, unknown> {
  if (!isPlainObject(config)) {
    return {};
  }

  const display: Record<string, unknown> = {};
  for (const key of DISPLAY_KEYS) {
    if (config[key] !== undefined) {
      display[key] = config[key];
    }
  }

  return display;
}
