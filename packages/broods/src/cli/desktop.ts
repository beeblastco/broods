/**
 * Runs the Swift helper behind `broods machine --computer`: one long-lived
 * child, one JSON request per line in and one reply per line out. The helper
 * is compiled with `swiftc` on first use into ~/.broods/desktop/<hash>/.
 */

import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type {
  MachineComputerFrame,
  MachineComputerResultFrame,
} from "../../../../apps/core/src/shared/machine-socket.ts";
import helperSource from "../desktop/broods-desktop.swift" with { type: "text" };

const HELPER_NAME = "broods-desktop";
const HELPER_ROOT = join(homedir(), ".broods", "desktop");
// wait and hold_key run up to 300s inside the helper.
const REPLY_TIMEOUT_MS = 320_000;

type HelperReply = Omit<MachineComputerResultFrame, "type"> & {
  display?: DesktopDisplay;
  permissions?: DesktopPermissions;
};

type HelperRequest =
  | MachineComputerFrame
  | { action: "display" | "permissions"; request?: boolean };

/** The screenshot frame: the main display scaled to fit 1280 on its long edge. */
export interface DesktopDisplay {
  width: number;
  height: number;
  scale: number;
}

export interface DesktopPermissions {
  accessibility: boolean;
  screenRecording: boolean;
}

export interface DesktopReport {
  display: DesktopDisplay;
  driver: DesktopDriver;
  permissions: DesktopPermissions;
}

interface PendingReply {
  resolve: (reply: HelperReply) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class DesktopDriver {
  readonly #child: ChildProcessByStdio<Writable, Readable, null>;
  #exited = false;
  readonly #pending = new Map<string, PendingReply>();

  constructor(binary: string) {
    this.#child = spawn(binary, [], { stdio: ["pipe", "pipe", "inherit"] });
    createInterface({ input: this.#child.stdout }).on(
      "line",
      (line: string): void => {
        let reply: HelperReply;
        try {
          reply = JSON.parse(line) as HelperReply;
        } catch {
          return;
        }
        const pending = this.#pending.get(reply.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.#pending.delete(reply.id);
        pending.resolve(reply);
      },
    );
    this.#child.on("exit", (code): void => {
      this.#exited = true;
      for (const [id, pending] of this.#pending) {
        clearTimeout(pending.timer);
        pending.resolve({
          id: id,
          error: `the desktop helper exited (${code ?? "signal"})`,
        });
      }
      this.#pending.clear();
    });
  }

  async display(): Promise<DesktopDisplay> {
    const reply = await this.#request({ action: "display" });
    if (!reply.display) throw new Error(reply.error ?? "no display reported");

    return reply.display;
  }

  /** With `request`, macOS shows its permission prompts for this terminal. */
  async permissions(request: boolean): Promise<DesktopPermissions> {
    const reply = await this.#request({
      action: "permissions",
      request: request,
    });
    if (!reply.permissions) {
      throw new Error(reply.error ?? "no permissions reported");
    }

    return reply.permissions;
  }

  async run(frame: MachineComputerFrame): Promise<MachineComputerResultFrame> {
    const reply = await this.#request(frame);

    return { ...reply, type: "computer-result", id: frame.id };
  }

  stop(): void {
    this.#child.kill("SIGTERM");
  }

  #request(request: HelperRequest): Promise<HelperReply> {
    const id = "id" in request ? request.id : crypto.randomUUID();
    if (this.#exited) {
      return Promise.resolve({
        id: id,
        error: "the desktop helper is not running",
      });
    }

    return new Promise((resolve): void => {
      const timer = setTimeout((): void => {
        this.#pending.delete(id);
        resolve({ id: id, error: "the desktop helper did not answer" });
      }, REPLY_TIMEOUT_MS);
      this.#pending.set(id, { resolve: resolve, timer: timer });
      this.#child.stdin.write(`${JSON.stringify({ ...request, id: id })}\n`);
    });
  }
}

/** Throws with the fix when this computer cannot build or start the helper. */
export async function startDesktop(request: boolean): Promise<DesktopReport> {
  const driver = new DesktopDriver(buildHelper());
  try {
    const display = await driver.display();
    const permissions = await driver.permissions(request);

    return { display: display, driver: driver, permissions: permissions };
  } catch (error) {
    driver.stop();
    throw error;
  }
}

// Keyed by the source hash, so a CLI upgrade rebuilds and an unchanged one starts at once.
function buildHelper(): string {
  if (process.platform !== "darwin") {
    throw new Error("computer use is macOS only for now");
  }
  const hash = createHash("sha256")
    .update(helperSource)
    .digest("hex")
    .slice(0, 16);
  const dir = join(HELPER_ROOT, hash);
  const binary = join(dir, HELPER_NAME);
  if (existsSync(binary)) return binary;
  mkdirSync(dir, { recursive: true });
  const source = join(dir, `${HELPER_NAME}.swift`);
  writeFileSync(source, helperSource);
  const build = spawnSync("swiftc", ["-O", "-o", binary, source], {
    encoding: "utf8",
  });
  if (build.error) {
    throw new Error(
      "computer use needs the Swift compiler. Install Xcode Command Line Tools: xcode-select --install",
    );
  }
  if (build.status !== 0) {
    throw new Error(`the desktop helper failed to build:\n${build.stderr}`);
  }

  return binary;
}
