/**
 * The browser side of a `scope: "user"` machine sandbox: what an end user's
 * browser extension runs to let that user's agent runs read and act on their
 * page. Dependency-free on purpose, so a Chrome MV3 service worker can bundle
 * it as is, and so can Bun or Node. It holds one socket per sandbox, answers
 * core's `browser` frames with `onAction`, keeps the service worker awake with
 * a ping, swaps in a fresh ticket before the current one expires, and
 * reconnects with backoff. The frame shapes mirror core's
 * `apps/core/src/shared/machine-socket.ts`; a test holds them equal.
 */

// Core's close codes a reconnect would only repeat: a malformed frame, a
// ticket for another user or sandbox or a refused Origin, no such sandbox, and
// this user's newer socket taking over (two would push each other out).
const FATAL_CLOSE_CODES: ReadonlySet<number> = new Set([
  4400, 4403, 4404, 4409,
]);
// Chrome stops an extension's service worker after 30 idle seconds.
const PING_MS = 20_000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_MIN_MS = 1_000;

/** One action core asks the browser to run, already checked by core. */
export type BrowserAction =
  | { action: "click"; ref: string }
  | { action: "fill"; fields: { ref: string; value: string }[] }
  | { action: "navigate"; url: string }
  | { action: "press_key"; key: string }
  | { action: "read_page" }
  | { action: "screenshot" }
  | { action: "type"; text: string }
  | { action: "upload_file"; ref: string; url: string; name: string };

/**
 * What the browser answers. `read_page` returns the page as text with a ref
 * per element the agent can act on; `screenshot` an image. Set `error` when
 * the action could not run.
 */
export interface BrowserActionResult {
  text?: string;
  image?: { data: string; mediaType: string };
  error?: string;
}

/** Where the connection stands, for the extension's own UI. */
export type BrowserConnectionStatus =
  | { kind: "connected"; sandboxId: string }
  | { kind: "disconnected"; reason: string; retryInMs: number }
  | { kind: "stopped"; code: number; reason: string };

export interface ConnectBrowserOptions {
  /** The stage's browser socket, from `browserSocketUrl`. */
  url: string;
  /**
   * A fresh `bbt_` ticket from your backend (`signBrowserTicket`), asked for
   * on every connect and every refresh. A ticket opens once, so never cache one.
   */
  getTicket: () => Promise<string>;
  /** The `scope: "user"` machine sandbox the ticket names. */
  sandbox: string;
  /** One id per extension install, shown in core's logs and the dashboard. */
  instance: string;
  /** Runs one action on the user's page. A throw answers with its message as `error`. */
  onAction: (action: BrowserAction) => Promise<BrowserActionResult>;
  onStatus?: (status: BrowserConnectionStatus) => void;
  /**
   * Opens the socket; the global WebSocket by default, which in an extension
   * sends its `chrome-extension://` Origin itself. A Bun or Node caller sets
   * that Origin header here.
   */
  createWebSocket?: (url: string, protocols: string[]) => WebSocket;
}

/** A live connection; `close` stops it for good. */
export interface BrowserConnection {
  close: () => void;
}

// What core sends a browser.
type CoreFrame =
  | { type: "browser"; id: string; input: BrowserAction }
  | { type: "ready"; sandboxId: string; expiresInMs?: number };

/** `wss://…/v1/projects/{projectId}/stages/{stageId}/browsers/ws` on your Broods base URL. */
export function browserSocketUrl(input: {
  baseUrl: string;
  projectId: string;
  stageId: string;
}): string {
  const url = new URL(
    `/v1/projects/${encodeURIComponent(input.projectId)}/stages/${encodeURIComponent(input.stageId)}/browsers/ws`,
    input.baseUrl,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  return url.toString();
}

/**
 * Connects this browser to its sandbox until `close`, or until core refuses
 * for good (`onStatus` reports `stopped`). Any other drop reconnects with a
 * fresh ticket, 1 s doubling to 30 s.
 */
export function connectBrowser(
  options: ConnectBrowserOptions,
): BrowserConnection {
  const createWebSocket =
    options.createWebSocket ??
    ((url: string, protocols: string[]): WebSocket =>
      new WebSocket(url, protocols));
  let stopped = false;
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let delayMs = RECONNECT_MIN_MS;

  const reconnect = (reason: string): void => {
    if (stopped) return;
    options.onStatus?.({
      kind: "disconnected",
      reason: reason,
      retryInMs: delayMs,
    });
    retry = setTimeout((): void => void open(), delayMs);
    delayMs = Math.min(delayMs * 2, RECONNECT_MAX_MS);
  };

  const open = async (): Promise<void> => {
    let ticket: string;
    try {
      ticket = await options.getTicket();
    } catch (error: unknown) {
      reconnect(`no ticket: ${errorMessage(error)}`);

      return;
    }
    if (stopped) return;
    const startedAt = Date.now();
    const ws = createWebSocket(options.url, [
      "broods.v1",
      `broods.token.${ticket}`,
    ]);
    socket = ws;
    let ping: ReturnType<typeof setInterval> | undefined;
    let refresh: ReturnType<typeof setTimeout> | undefined;
    const send = (frame: object): void => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
    };
    // Core closes the socket at the ticket's expiry, so a fresh one goes in at
    // half the time left, and again at half of what is left then until core
    // answers with a new deadline.
    const refreshBefore = (expiresAt: number): void => {
      clearTimeout(refresh);
      refresh = setTimeout(
        (): void => {
          void options
            .getTicket()
            .then(
              (fresh): void => send({ type: "credential", token: fresh }),
              (): void => undefined,
            )
            .finally((): void => refreshBefore(expiresAt));
        },
        Math.max((expiresAt - Date.now()) / 2, RECONNECT_MIN_MS),
      );
    };

    ws.onopen = (): void => {
      send({
        type: "hello",
        sandbox: options.sandbox,
        instance: options.instance,
        browser: true,
      });
      ping = setInterval((): void => send({ type: "ping" }), PING_MS);
    };
    ws.onmessage = (event: MessageEvent): void => {
      const frame = parseCoreFrame(event.data);
      if (frame?.type === "ready") {
        // A later ready only acknowledges a fresh ticket.
        if (refresh === undefined) {
          options.onStatus?.({ kind: "connected", sandboxId: frame.sandboxId });
        }
        if (frame.expiresInMs !== undefined) {
          refreshBefore(Date.now() + frame.expiresInMs);
        }

        return;
      }
      if (frame?.type === "browser") {
        void answer(options, frame.id, frame.input).then(send);
      }
    };
    ws.onclose = (event: CloseEvent): void => {
      clearInterval(ping);
      clearTimeout(refresh);
      if (socket === ws) socket = undefined;
      if (stopped) return;
      if (FATAL_CLOSE_CODES.has(event.code)) {
        stopped = true;
        options.onStatus?.({
          kind: "stopped",
          code: event.code,
          reason: event.reason,
        });

        return;
      }
      if (Date.now() - startedAt > RECONNECT_MAX_MS) delayMs = RECONNECT_MIN_MS;
      reconnect(event.reason || `closed (${event.code})`);
    };
  };

  void open();

  return {
    close: (): void => {
      stopped = true;
      clearTimeout(retry);
      socket?.close(1000, "extension stopped");
    },
  };
}

// The `browser-result` frame for one action, with only the fields core reads.
async function answer(
  options: ConnectBrowserOptions,
  id: string,
  input: BrowserAction,
): Promise<object> {
  let result: BrowserActionResult;
  try {
    result = await options.onAction(input);
  } catch (error: unknown) {
    result = { error: errorMessage(error) };
  }

  return {
    type: "browser-result",
    id: id,
    ...(result.text === undefined ? {} : { text: result.text }),
    ...(result.image ? { image: result.image } : {}),
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Core's frames as core sends them; anything else is ignored.
function parseCoreFrame(data: unknown): CoreFrame | null {
  if (typeof data !== "string") return null;
  try {
    return JSON.parse(data) as CoreFrame;
  } catch {
    return null;
  }
}
