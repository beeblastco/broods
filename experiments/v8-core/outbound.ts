/**
 * Runs before any other module. With a WRITES binding (slimDirectConfig) a task worker sends only
 * the usage, budget and sandbox-mirror writes, which race on one account's usage rows, through the
 * shared write queue (per-task/write-queue.js); everything else goes out directly.
 */

// ConvexHttpClient sends JSON.stringify({ path, format, args }), so the path leads the body.
const QUEUED = [
  '{"path":"usage:recordTaskUsage"',
  '{"path":"account/budget:record"',
  '{"path":"sandbox/instances:upsert"',
];

let writes: { fetch: typeof fetch } | undefined;

/** The WRITES binding from the task worker's env, or undefined to send everything directly. */
export function setWriteQueue(
  binding: { fetch: typeof fetch } | undefined,
): void {
  writes = binding;
}

const direct = globalThis.fetch;
globalThis.fetch = function fetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const body = init?.body;
  if (
    writes !== undefined &&
    init?.method === "POST" &&
    typeof body === "string" &&
    QUEUED.some((prefix) => body.startsWith(prefix))
  )
    return writes.fetch(input, init);

  return direct(input, init);
} as typeof fetch;
