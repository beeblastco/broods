/**
 * Frames between the `broods machine` daemon and core. The gateway relays
 * them unchanged and the CLI bundles this file.
 */

import { z } from "zod";

export const MACHINE_CLOSE = {
  badFrame: { code: 4400, reason: "Malformed frame" },
  replaced: { code: 4409, reason: "Replaced by a newer connection" },
  unauthorized: { code: 4401, reason: "Unauthorized; check BROODS_API_KEY" },
  unknownSandbox: {
    code: 4404,
    reason: "No machine sandbox with that name in this account",
  },
} as const;

export const MACHINE_WEBSOCKET_PATH = "/v1/machines/ws";

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

const coreFrame = z.discriminatedUnion("type", [execFrame, readyFrame]);

const daemonFrame = z.discriminatedUnion("type", [helloFrame, resultFrame]);

export type MachineCoreFrame = z.infer<typeof coreFrame>;
export type MachineDaemonFrame = z.infer<typeof daemonFrame>;
export type MachineExecFrame = z.infer<typeof execFrame>;
export type MachineHelloFrame = z.infer<typeof helloFrame>;
export type MachineReadyFrame = z.infer<typeof readyFrame>;
export type MachineResultFrame = z.infer<typeof resultFrame>;

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
