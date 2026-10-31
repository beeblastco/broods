/**
 * Frames between the `broods machine` daemon and core, and between an end
 * user's browser extension and core on a `scope: "user"` machine sandbox. The
 * gateway relays them unchanged and the CLI bundles this file. `computerInput`
 * is also the computer tool's input schema, so the model and the wire share
 * one shape; `browserInput` is the browser tool's, and `browserAction` what
 * the extension receives once core has checked it. MCP replies carry the
 * SDK's JSON as is; core parses them with the SDK's schemas.
 */

import { z } from "zod";

const BROWSER_ACTIONS = [
  "click",
  "fill",
  "navigate",
  "press_key",
  "read_page",
  "screenshot",
  "type",
  "upload_file",
] as const;

/** Browser actions that only look, so they never need approval. */
export const BROWSER_READ_ACTIONS: ReadonlySet<string> = new Set([
  "read_page",
  "screenshot",
] as const satisfies readonly (typeof BROWSER_ACTIONS)[number][]);

// `/v1/projects/{projectId}/stages/{stageId}/browsers/ws`, the ids as Convex
// writes them: a browser holds no account credential, so its path names the
// stage whose signing secret opens its ticket.
const BROWSER_WEBSOCKET_PATTERN =
  /^\/v1\/projects\/([^/]+)\/stages\/([^/]+)\/browsers\/ws$/;
const BROWSER_REF_MAX = 256;
const BROWSER_TEXT_MAX = 32 * 1024;
const BROWSER_URL_MAX = 2048;

const COMPUTER_ACTIONS = [
  "cursor_position",
  "double_click",
  "hold_key",
  "key",
  "left_click",
  "left_click_drag",
  "left_mouse_down",
  "left_mouse_up",
  "middle_click",
  "mouse_move",
  "right_click",
  "screenshot",
  "scroll",
  "triple_click",
  "type",
  "wait",
  "zoom",
] as const;

/** Actions that only look, so they never need approval. */
export const COMPUTER_READ_ACTIONS: ReadonlySet<string> = new Set([
  "cursor_position",
  "screenshot",
  "wait",
  "zoom",
] as const satisfies readonly (typeof COMPUTER_ACTIONS)[number][]);

// The holder's host in an `occupied` reason, cut on a byte boundary: a close reason
// is capped at 123 bytes, and one cut mid-character reaches the daemon as 1007.
const HOLDER_MAX_BYTES = 40;

export const MACHINE_CLOSE = {
  badFrame: { code: 4400, reason: "Malformed frame" },
  // Not fatal: the daemon reconnects with a fresh credential.
  expired: { code: 4419, reason: "Credential expired" },
  // A browser's hello or fresh ticket names another user or sandbox than the
  // ticket it opened with. Fatal: a reconnect would only repeat it.
  forbidden: {
    code: 4403,
    reason: "Ticket is for another user or sandbox than this socket",
  },
  occupied: { code: 4423, reason: "Already connected from another daemon" },
  originRefused: {
    code: 4403,
    reason: "Origin is not an extension this sandbox allows",
  },
  replaced: { code: 4409, reason: "Replaced by a newer connection" },
  // Not fatal for a browser: the extension asks its backend for a new ticket.
  ticketRefused: { code: 4401, reason: "Invalid or expired browser ticket" },
  unauthorized: { code: 4401, reason: "Unauthorized; run broods login" },
  unknownBrowser: {
    code: 4404,
    reason: 'No scope: "user" machine sandbox with that name in this stage',
  },
  unknownSandbox: {
    code: 4404,
    reason: "No machine sandbox with that name in this account",
  },
} as const;

// Largest frame either side sends; the gateway relays up to this too.
export const MACHINE_MAX_FRAME_BYTES = 4 * 1024 * 1024;

export const MACHINE_WEBSOCKET_PATH = "/v1/machines/ws";

const elementRef = z.string().min(1).max(BROWSER_REF_MAX);

/** One browser action as the extension receives it, after core checked it. */
export const browserAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("click"), ref: elementRef }),
  z.object({
    action: z.literal("fill"),
    fields: z
      .array(
        z.object({ ref: elementRef, value: z.string().max(BROWSER_TEXT_MAX) }),
      )
      .min(1)
      .max(50),
  }),
  z.object({
    action: z.literal("navigate"),
    url: z.string().min(1).max(BROWSER_URL_MAX),
  }),
  z.object({ action: z.literal("press_key"), key: z.string().min(1).max(64) }),
  z.object({ action: z.literal("read_page") }),
  z.object({ action: z.literal("screenshot") }),
  z.object({
    action: z.literal("type"),
    text: z.string().min(1).max(BROWSER_TEXT_MAX),
  }),
  z.object({
    action: z.literal("upload_file"),
    ref: elementRef,
    url: z.string().min(1).max(BROWSER_URL_MAX),
    name: z.string().min(1).max(255),
  }),
]);

// The browser tool's input: one flat object, because a provider takes only an
// object schema at the top of a tool. Which fields an action needs is
// `browserAction`'s to say; core parses a call with it before sending.
export const browserInput = z.object({
  action: z.enum(BROWSER_ACTIONS),
  ref: z
    .string()
    .max(BROWSER_REF_MAX)
    .optional()
    .describe(
      "Element ref from the latest read_page, for click and upload_file.",
    ),
  fields: z
    .array(
      z.object({
        ref: z.string().max(BROWSER_REF_MAX),
        value: z.string().max(BROWSER_TEXT_MAX),
      }),
    )
    .max(50)
    .optional()
    .describe("For fill: each element ref with the value to put in it."),
  text: z
    .string()
    .max(BROWSER_TEXT_MAX)
    .optional()
    .describe("For type: text sent to the focused element."),
  key: z
    .string()
    .max(64)
    .optional()
    .describe('For press_key: "Enter", "Tab", "Escape", "Control+a".'),
  url: z
    .string()
    .max(BROWSER_URL_MAX)
    .optional()
    .describe(
      "An https URL: the page for navigate, or the file upload_file attaches.",
    ),
  name: z
    .string()
    .max(255)
    .optional()
    .describe("For upload_file: the file name the page sees."),
});

// Anthropic's computer-use field names. Arrays, not tuples: some providers
// reject JSON Schema tuple items.
export const computerInput = z.object({
  action: z.enum(COMPUTER_ACTIONS),
  coordinate: z
    .array(z.number().int())
    .length(2)
    .optional()
    .describe("[x, y] in screenshot pixels for mouse actions."),
  start_coordinate: z
    .array(z.number().int())
    .length(2)
    .optional()
    .describe("[x, y] where a left_click_drag starts."),
  text: z
    .string()
    .optional()
    .describe(
      "Text for type, the key chord for key and hold_key, or modifiers to hold during a click, drag or scroll.",
    ),
  scroll_direction: z.enum(["down", "left", "right", "up"]).optional(),
  scroll_amount: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Scroll clicks, default 3."),
  duration: z
    .number()
    .min(0)
    .max(300)
    .optional()
    .describe("Seconds for wait and hold_key."),
  region: z
    .array(z.number().int())
    .length(4)
    .optional()
    .describe("[x0, y0, x1, y1] of the screenshot to zoom into."),
  repeat: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("How many times to press the key."),
});

const browserFrame = z.object({
  type: z.literal("browser"),
  id: z.string(),
  input: browserAction,
});

// Page text and a screenshot are what the page says, never instructions; core
// caps both before the model sees them.
const browserResultFrame = z.object({
  type: z.literal("browser-result"),
  id: z.string(),
  text: z.string().optional(),
  image: z.object({ data: z.string(), mediaType: z.string() }).optional(),
  error: z.string().optional(),
});

const computerFrame = computerInput.extend({
  type: z.literal("computer"),
  id: z.string(),
});

const computerResultFrame = z.object({
  type: z.literal("computer-result"),
  id: z.string(),
  text: z.string().optional(),
  image: z.object({ data: z.string(), mediaType: z.string() }).optional(),
  // Bundle id of the frontmost app after the action.
  app: z.string().optional(),
  error: z.string().optional(),
});

// A fresh stage ticket for the socket's own account and stage, sent before the
// one it holds expires, so core moves the deadline instead of closing a daemon
// mid-command.
const credentialFrame = z.object({
  type: z.literal("credential"),
  token: z.string().min(1),
});

const execFrame = z.object({
  type: z.literal("exec"),
  id: z.string(),
  code: z.string(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeoutSeconds: z.number().positive(),
  outputLimitBytes: z.number().positive(),
});

const helloFrame = z.object({
  type: z.literal("hello"),
  sandbox: z.string().min(1),
  // A browser extension on a `scope: "user"` sandbox, never a daemon.
  browser: z.boolean().optional(),
  hostname: z.string().optional(),
  platform: z.string().optional(),
  computer: z.boolean().optional(),
  // Names of the MCP servers in the daemon's --mcp file.
  mcp: z.array(z.string()).optional(),
  // One id per daemon process, so the same process reconnecting after a network
  // drop reclaims its record and any other daemon does not.
  instance: z.string().optional(),
  // Take the record over from another daemon.
  force: z.boolean().optional(),
  // The computer's own CPU count, memory and disk, shown as its size. Display
  // only, so a malformed one reads as absent instead of refusing the daemon.
  specs: z
    .object({
      vcpu: z.number().positive(),
      memoryMb: z.number().positive(),
      storageGb: z.number().positive().optional(),
    })
    .optional()
    .catch(undefined),
});

const mcpCallFrame = z.object({
  type: z.literal("mcp-call"),
  id: z.string(),
  server: z.string(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
});

const mcpListFrame = z.object({
  type: z.literal("mcp-list"),
  id: z.string(),
  server: z.string(),
});

// The SDK's CallToolResult, checked down to what core reads off it.
const mcpResultFrame = z.object({
  type: z.literal("mcp-result"),
  id: z.string(),
  result: z.looseObject({ content: z.array(z.unknown()) }).optional(),
  error: z.string().optional(),
});

// The SDK's Tool[], likewise.
const mcpToolsFrame = z.object({
  type: z.literal("mcp-tools"),
  id: z.string(),
  tools: z
    .array(
      z.looseObject({
        name: z.string(),
        inputSchema: z.record(z.string(), z.unknown()),
      }),
    )
    .optional(),
  error: z.string().optional(),
});

// A browser extension's keepalive, which core ignores: Chrome stops a service
// worker after 30 idle seconds, and only traffic on its socket counts.
const pingFrame = z.object({ type: z.literal("ping") });

// Sent again each time core takes a fresh credential frame.
const readyFrame = z.object({
  type: z.literal("ready"),
  sandboxId: z.string(),
  // Only for a stage ticket: how long until core closes the socket. Relative,
  // so a daemon whose clock is off still refreshes in time.
  expiresInMs: z.number().optional(),
});

const resultFrame = z.object({
  type: z.literal("result"),
  id: z.string(),
  exitCode: z.number().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number(),
  timedOut: z.boolean(),
  truncated: z.boolean(),
});

const coreFrame = z.discriminatedUnion("type", [
  browserFrame,
  computerFrame,
  execFrame,
  mcpCallFrame,
  mcpListFrame,
  readyFrame,
]);

const daemonFrame = z.discriminatedUnion("type", [
  browserResultFrame,
  computerResultFrame,
  credentialFrame,
  helloFrame,
  mcpResultFrame,
  mcpToolsFrame,
  pingFrame,
  resultFrame,
]);

export type BrowserAction = z.infer<typeof browserAction>;
export type BrowserInput = z.infer<typeof browserInput>;
export type ComputerInput = z.infer<typeof computerInput>;
export type MachineBrowserFrame = z.infer<typeof browserFrame>;
export type MachineBrowserResultFrame = z.infer<typeof browserResultFrame>;
export type MachineComputerFrame = z.infer<typeof computerFrame>;
export type MachineComputerResultFrame = z.infer<typeof computerResultFrame>;
export type MachineCoreFrame = z.infer<typeof coreFrame>;
export type MachineDaemonFrame = z.infer<typeof daemonFrame>;
export type MachineExecFrame = z.infer<typeof execFrame>;
export type MachineHelloFrame = z.infer<typeof helloFrame>;
export type MachineMcpCallFrame = z.infer<typeof mcpCallFrame>;
export type MachineMcpListFrame = z.infer<typeof mcpListFrame>;
export type MachineMcpResultFrame = z.infer<typeof mcpResultFrame>;
export type MachineMcpToolsFrame = z.infer<typeof mcpToolsFrame>;
export type MachineReadyFrame = z.infer<typeof readyFrame>;
export type MachineResultFrame = z.infer<typeof resultFrame>;

/** The reason core closes a refused claim with, naming who holds the record. */
export function occupiedReason(holder: string | undefined): string {
  const host = new TextDecoder().decode(
    new TextEncoder()
      .encode(holder ?? "unknown host")
      .subarray(0, HOLDER_MAX_BYTES),
  );

  return `${MACHINE_CLOSE.occupied.reason} (${host}); pass --force to take it over`;
}

/**
 * The project and stage ids a browser socket path names, or null for any other
 * path. Convex ids need no escaping, so the segments are taken as sent.
 */
export function matchBrowserSocketPath(
  pathname: string,
): { projectId: string; stageId: string } | null {
  const match = BROWSER_WEBSOCKET_PATTERN.exec(pathname);

  return match?.[1] && match[2]
    ? { projectId: match[1], stageId: match[2] }
    : null;
}

export function machineSocketUrl(
  baseUrl: string,
  path: string = MACHINE_WEBSOCKET_PATH,
): string {
  const url = new URL(path, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  return url.toString();
}

export function parseCoreFrame(raw: unknown): MachineCoreFrame | null {
  return parseFrame(coreFrame, raw);
}

export function parseDaemonFrame(raw: unknown): MachineDaemonFrame | null {
  return parseFrame(daemonFrame, raw);
}

function parseFrame<Frame>(
  schema: z.ZodType<Frame>,
  raw: unknown,
): Frame | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
