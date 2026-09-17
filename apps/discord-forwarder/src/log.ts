/**
 * One JSON object per line on stdout, which is what Loki scrapes for every other
 * beeblast pod. Bot tokens never travel through here: callers pass the four-char
 * `tokenHint` this module derives, matching the `keyHint` convention the config
 * plane already uses for deploy keys.
 */

// The `service` label. `apps/matrix-forwarder` reuses these helpers and renames
// it once at startup through `setLogService`.
let service = "discord-forwarder";

type LogFields = Record<string, string | number | boolean | undefined>;

export function logError(message: string, fields: LogFields = {}): void {
  emit("error", message, fields);
}

export function logInfo(message: string, fields: LogFields = {}): void {
  emit("info", message, fields);
}

export function logWarn(message: string, fields: LogFields = {}): void {
  emit("warn", message, fields);
}

export function setLogService(name: string): void {
  service = name;
}

/** Stable, non-reversible label for a bot token, safe to put in a log line. */
export function tokenHint(botToken: string): string {
  return `…${botToken.slice(-4)}`;
}

function emit(level: string, message: string, fields: LogFields): void {
  // JSON.stringify omits undefined-valued keys, so optional fields need no guard.
  console.log(
    JSON.stringify({
      level: level,
      service: service,
      message: message,
      ...fields,
    }),
  );
}
