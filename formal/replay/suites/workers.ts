import type { Mutation, Suite } from "../suite.ts";

const WORKER_FILE = "apps/core/src/harness/worker-queue.ts";

// Faults injected into real source at load time. Replay must fail on each one, or it would also
// pass a rewrite that has the same fault. The source files on disk are never changed.
const MUTATIONS: readonly Mutation[] = [
  {
    name: "one slot too many",
    file: WORKER_FILE,
    find: "if (activeInProcessWorkers < MAX_INPROCESS_WORKERS) {",
    replace: "if (activeInProcessWorkers <= MAX_INPROCESS_WORKERS) {",
  },
  {
    name: "release does not start the next run",
    file: WORKER_FILE,
    find: "activeInProcessWorkers -= 1;\n      startNextWorker();",
    replace: "activeInProcessWorkers -= 1;",
  },
  {
    name: "queue is last in, first out",
    file: WORKER_FILE,
    find: "const next = pendingWorkerRuns.shift();",
    replace: "const next = pendingWorkerRuns.pop();",
  },
  {
    name: "run can yield past its slot limit",
    file: WORKER_FILE,
    find: "if (slotsUsed >= MAX_RUN_SLOTS) delete context.yieldSlot;",
    replace: "",
  },
  {
    name: "an overrun keeps its slot",
    file: WORKER_FILE,
    find: "releaseSlot?.();\n      abandon?.();",
    replace: "",
  },
  {
    name: "a run without a slot can still yield",
    file: WORKER_FILE,
    find: "if (runAbort.signal.aborted || !releaseSlot) return;",
    replace: "",
  },
  {
    name: "a placed dispatch can be shed",
    file: WORKER_FILE,
    find: "    !placed,\n  );",
    replace: "    true,\n  );",
  },
  {
    name: "a yielding run can be shed",
    file: WORKER_FILE,
    find: "// A run stopped mid-turn holding its lease is never load-shed.\n        false,",
    replace: "true,",
  },
  {
    name: "a place does not count toward fullness",
    file: WORKER_FILE,
    find: "activeInProcessWorkers + pendingWorkerRuns.length + heldQueuePlaces >=",
    replace: "activeInProcessWorkers + pendingWorkerRuns.length >=",
  },
  {
    name: "a used place stays held",
    file: WORKER_FILE,
    find: "    place.held = false;\n    heldQueuePlaces -= 1;\n  }\n  enqueueWorker(",
    replace: "    place.held = false;\n  }\n  enqueueWorker(",
  },
];

export const suite: Suite = {
  name: "workers",
  tests: ["formal/replay/workers.test.ts"],
  env: { MAX_INPROCESS_WORKERS: "2", MAX_RUN_SLOTS: "3" },
  mutations: MUTATIONS,
};
