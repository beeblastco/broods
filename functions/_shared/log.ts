/**
 * Shared logging helpers.
 */

function emit(level: string, message: string, data?: Record<string, unknown>) {
  const entry = { time: new Date().toISOString(), level, message, ...data };
  process.stdout.write(JSON.stringify(entry) + "\n");
}

export function logInfo(message: string, data?: Record<string, unknown>) {
  emit("INFO", message, data);
}

export function logWarn(message: string, data?: Record<string, unknown>) {
  emit("WARN", message, data);
}

export function logError(message: string, data?: Record<string, unknown>) {
  emit("ERROR", message, data);
}
