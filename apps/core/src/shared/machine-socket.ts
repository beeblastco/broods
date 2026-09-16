/**
 * Frames between the `broods machine` daemon and core. The gateway relays
 * them unchanged and the CLI bundles this file. `computerInput` is also the
 * computer tool's input schema, so the model and the wire share one shape. MCP
 * replies carry the SDK's JSON as is; core parses them with the SDK's schemas.
 */

import { z } from "zod";

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
  occupied: { code: 4423, reason: "Already connected from another daemon" },
  replaced: { code: 4409, reason: "Replaced by a newer connection" },
  unauthorized: { code: 4401, reason: "Unauthorized; check BROODS_API_KEY" },
  unknownSandbox: {
    code: 4404,
    reason: "No machine sandbox with that name in this account",
  },
} as const;

export const MACHINE_WEBSOCKET_PATH = "/v1/machines/ws";

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

const readyFrame = z.object({
  type: z.literal("ready"),
  sandboxId: z.string(),
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
  computerFrame,
  execFrame,
  mcpCallFrame,
  mcpListFrame,
  readyFrame,
]);

const daemonFrame = z.discriminatedUnion("type", [
  computerResultFrame,
  helloFrame,
  mcpResultFrame,
  mcpToolsFrame,
  resultFrame,
]);

export type ComputerInput = z.infer<typeof computerInput>;
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

export function machineSocketUrl(baseUrl: string): string {
  const url = new URL(MACHINE_WEBSOCKET_PATH, baseUrl);
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
