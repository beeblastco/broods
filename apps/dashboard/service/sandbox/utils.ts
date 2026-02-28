/** Structured JSON logger for the sandbox service. */
export const log = {
  info(msg: string, data?: Record<string, unknown>) {
    console.log(JSON.stringify({ level: "info", msg: msg, ...data, ts: Date.now() }));
  },
  warn(msg: string, data?: Record<string, unknown>) {
    console.warn(JSON.stringify({ level: "warn", msg: msg, ...data, ts: Date.now() }));
  },
  error(msg: string, data?: Record<string, unknown>) {
    console.error(JSON.stringify({ level: "error", msg: msg, ...data, ts: Date.now() }));
  },
};
