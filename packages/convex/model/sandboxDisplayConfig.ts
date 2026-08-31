/**
 * Display-safe projection of a sandbox config for the canvas layout.
 *
 * Layouts are UI state the dashboard reads back verbatim, so they must never
 * carry `envVars` or provider `options` — those hold credentials. These keys
 * are exactly what the sandbox node and its side panel render: the globe reads
 * `network.mode`, the feature row reads `persistent`, and the config tab shows
 * `provider` and `permissionMode`.
 */

import { isPlainObject } from "./objects";

const DISPLAY_KEYS = [
  "network",
  "permissionMode",
  "persistent",
  "provider",
] as const;

/** Keep only the keys the canvas renders; drop everything else. */
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
