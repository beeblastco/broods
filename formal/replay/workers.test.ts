import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  dispatchInProcessWorker,
  withQueuePlace,
  WORKER_QUEUE_FULL,
} from "../../apps/core/src/harness/worker-queue.ts";
import type { RequestContext } from "../../apps/core/src/shared/http.ts";

interface Effect {
  kind: string;
  run?: number;
  slot?: number;
  place?: number;
}

interface Input {
  kind: string;
  run?: number;
  place?: number | null;
}

interface Vector {
  name: string;
  steps: { input: Input; effects: Effect[] }[];
}

interface LiveRun {
  phase: "running" | "yielding" | "ended";
  slot: number;
  context: RequestContext;
  settle: () => void;
  timer: () => void;
}

interface OpenPlace {
  send: (command: () => void) => void;
  close: () => void;
}

const SEED = 20261105;
const VECTORS = 60;
const LENGTH = 120;

// Replays each model trace against the real queue. Each run's body is driven from here, so the
// test sees only what the code does: which runs start, which are refused, which abort.
describe("worker queue matches the model", (): void => {
  test.each(
    loadVectors().map((vector): [string, Vector] => [vector.name, vector]),
  )("%s", async (_name: string, vector: Vector): Promise<void> => {
    await replay(vector);
  });
});

function loadVectors(): Vector[] {
  const result = spawnSync(
    `${import.meta.dir}/../.lake/build/bin/spec-replay`,
    ["workers", String(VECTORS), String(LENGTH), String(SEED)],
    { encoding: "utf8", maxBuffer: 1 << 30 },
  );
  if (result.status !== 0) {
    throw new Error(`run lake build in formal/ first: ${result.stderr}`);
  }

  return result.stdout
    .trim()
    .split("\n")
    .map((line): Vector => JSON.parse(line) as Vector);
}

async function replay(vector: Vector): Promise<void> {
  const runs = new Map<number, LiveRun>();
  const places = new Map<number, OpenPlace>();
  const timers: (() => void)[] = [];
  let effects: Effect[] = [];
  const realSetTimeout = globalThis.setTimeout;
  // Slot timers are the only timers this path creates, and each is an `overrun` input here.
  globalThis.setTimeout = ((callback: () => void, delay?: number) => {
    if (delay !== 0) {
      timers.push(callback);

      return { unref: (): void => {} };
    }

    return realSetTimeout(callback, 0);
  }) as unknown as typeof setTimeout;

  const body = (id: number) => {
    return (context: RequestContext): Promise<void> => {
      context.abortSignal?.addEventListener("abort", (): void => {
        effects.push({ kind: "aborted", run: id });
      });
      effects.push({ kind: "started", run: id, slot: 1 });

      return new Promise<void>((resolve): void => {
        runs.set(id, {
          phase: "running",
          slot: 1,
          context: context,
          settle: resolve,
          timer: timers.shift() ?? ((): void => {}),
        });
      });
    };
  };

  const dispatch = (id: number): void => {
    try {
      dispatchInProcessWorker("replay", body(id));
    } catch (err) {
      if (err instanceof Error && err.message === WORKER_QUEUE_FULL) {
        effects.push({ kind: "refused", run: id });

        return;
      }
      throw err;
    }
  };

  const openPlace = (id: number): void => {
    let wake: (() => void) | undefined;
    const commands: (() => void)[] = [];
    let closing = false;
    let admitted = false;
    void withQueuePlace(async (): Promise<void> => {
      admitted = true;
      while (!closing) {
        const command = commands.shift();
        if (command) {
          command();
          continue;
        }
        await new Promise<void>((resolve): void => {
          wake = resolve;
        });
      }
    });
    if (!admitted) {
      effects.push({ kind: "placeRefused", place: id });

      return;
    }
    places.set(id, {
      send: (command): void => {
        commands.push(command);
        wake?.();
      },
      close: (): void => {
        closing = true;
        wake?.();
      },
    });
  };

  const apply = (input: Input): void => {
    const live = input.run === undefined ? undefined : runs.get(input.run);
    switch (input.kind) {
      case "openPlace":
        openPlace(input.place as number);

        return;
      case "closePlace":
        places.get(input.place as number)?.close();
        places.delete(input.place as number);

        return;
      case "dispatch": {
        const id = input.run as number;
        const place =
          input.place === null ? undefined : places.get(input.place as number);
        if (place) place.send((): void => dispatch(id));
        else dispatch(id);

        return;
      }
      case "settle":
        if (live?.phase === "running") {
          runs.delete(input.run as number);
          live.settle();
        }

        return;
      case "overrun":
        if (live?.phase === "running") {
          live.phase = "ended";
          live.timer();
        }

        return;
      case "yieldSlot": {
        // oxlint-disable-next-line typescript/unbound-method -- called detached, the way the code under test calls it
        const yieldSlot = live?.context.yieldSlot;
        if (!live || live.phase === "yielding" || !yieldSlot) return;
        // A stale handle stays callable after an overrun, so the code must ignore it by itself.
        const wasEnded = live.phase === "ended";
        if (!wasEnded) live.phase = "yielding";
        void yieldSlot(undefined).then((): void => {
          if (wasEnded) return;
          live.phase = "running";
          live.slot += 1;
          live.timer = timers.shift() ?? ((): void => {});
          effects.push({
            kind: "started",
            run: input.run as number,
            slot: live.slot,
          });
        });

        return;
      }
      default:
        throw new Error(`unknown input ${input.kind}`);
    }
  };

  try {
    for (const [index, step] of vector.steps.entries()) {
      effects = [];
      apply(step.input);
      await new Promise((resolve): void => {
        setImmediate(resolve);
      });
      expect({ index: index, input: step.input, effects: effects }).toEqual({
        index: index,
        input: step.input,
        effects: step.effects,
      });
    }
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
}
