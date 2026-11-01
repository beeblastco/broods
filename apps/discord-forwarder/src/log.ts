let service = "discord-forwarder";

export type LogFields = Record<string, string | number | boolean | undefined>;

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

/** Log this, never the bot token itself. */
export function tokenHint(botToken: string): string {
  return `…${botToken.slice(-4)}`;
}

function emit(level: string, message: string, fields: LogFields): void {
  console.log(
    JSON.stringify({
      level: level,
      service: service,
      message: message,
      ...fields,
    }),
  );
}
