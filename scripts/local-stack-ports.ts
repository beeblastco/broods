import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

const PORT_BLOCK_BASE = 4300;
const PORT_BLOCK_SIZE = 10;
const PORT_BLOCK_COUNT = 50;
const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 30_000;

interface SavedState {
  portBase: number;
}

// Picks a block no `<root>/*/state.json` holds and runs `claim` with it under a lock on
// `root`, so `claim` saving the new state makes the pick visible before anyone else picks.
export function reservePortBase<T>(
  root: string,
  claim: (portBase: number) => T,
): T {
  const lock = join(root, ".ports.lock");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  acquire(lock);
  try {
    return claim(freePortBase(root));
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

// mkdir is atomic; a lock older than LOCK_STALE_MS was left by a crashed run.
function acquire(lock: string): void {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);

      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const heldSince =
      statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now();
    if (Date.now() - heldSince > LOCK_STALE_MS) {
      rmSync(lock, { recursive: true, force: true });
    } else if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${lock}`);
    } else {
      Bun.sleepSync(25);
    }
  }
}

function freePortBase(root: string): number {
  const used = new Set<number>();
  for (const entry of readdirSync(root)) {
    const path = join(root, entry, "state.json");
    if (!existsSync(path)) continue;
    const state = JSON.parse(readFileSync(path, "utf8")) as SavedState;
    used.add(state.portBase);
  }
  for (let index = 0; index < PORT_BLOCK_COUNT; index += 1) {
    const base = PORT_BLOCK_BASE + index * PORT_BLOCK_SIZE;
    if (!used.has(base)) return base;
  }
  throw new Error(`no free port block under ${root}`);
}
