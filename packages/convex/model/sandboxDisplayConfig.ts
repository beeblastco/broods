import { configObject, parseOr } from "./inputSchema";

// Layouts are read back verbatim: never envVars or options, which hold credentials. A key
// the config tab edits but this list drops is wiped from the stored config on canvas save.
const DISPLAY_KEYS = [
  "image",
  "network",
  "permissionMode",
  "persistent",
  "provider",
  "snapshot",
] as const;

export function sandboxDisplayConfig(value: unknown): Record<string, unknown> {
  const config = parseOr(configObject, value);
  if (!config) {
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
