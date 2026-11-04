// The Worker itself is tested in its own workspace under Miniflare.

import {
  afterEach,
  beforeEach,
  expect,
  it,
  mock,
  setSystemTime,
  spyOn,
} from "bun:test";
import { MAX_TIMEOUT_MS } from "../../cloudflare-worker/src/limits.ts";
import * as planLimits from "../src/harness/plan-limits.ts";
import {
  deleteSandboxInstance,
  resetHeldReservationsForTests,
} from "../src/harness/sandbox/instance-store.ts";
import {
  WorkerSandboxExecutor,
  workerConnection,
} from "../src/harness/sandbox/worker-executor.ts";
import type { SandboxExecutorConfig } from "../src/harness/sandbox/types.ts";
import { runtime } from "../src/shared/convex/runtime.ts";
import * as sandboxInstances from "../src/shared/convex/sandbox-instances.ts";
import { requestUrl } from "./helpers/http.ts";
import { WORKER_MAX_TIMEOUT_SECONDS } from "@broods/convex/model/sandboxRules";

const EXEC_OK = {
  ok: true,
  exit_code: 0,
  timed_out: false,
  duration_ms: 5,
  stdout: "ok\n",
  stderr: "",
  truncated: false,
};
const config: SandboxExecutorConfig = {
  provider: "worker",
  network: { mode: "deny-all" },
  envVars: { ACCOUNT_VAR: "a" },
  controlPlane: {
    accountId: "acct",
    name: "box",
    specs: { vcpu: 1, memoryMb: 128, storageGb: 0 },
  },
};
const request = {
  code: "true",
  reservationKey: "acct:workspace",
  timeoutSeconds: 10,
  outputLimitBytes: 1024,
};

interface WorkerCall {
  method: string;
  url: string;
  authorization: string | null;
  body: Record<string, unknown> | null;
}

const calls: WorkerCall[] = [];
const mirrored: string[] = [];
const metered: string[] = [];
// The reservation calls that reach Convex, in order.
const convex: string[] = [];
let stored: string | null = null;
let claimWins = true;
let accountActive = true;
// Holds a booking's answer on its way back, after its transaction ran.
let answerGate: Promise<void> | undefined;
// Holds a row delete until opened; the row goes before the hold or after it.
let rowDelete: { opened: Promise<void>; goneFirst: boolean } | undefined;

beforeEach((): void => {
  process.env.CLOUDFLARE_WORKER_URL = "https://worker.example.com/";
  process.env.CLOUDFLARE_WORKER_API_KEY = "worker-key";
  stored = null;
  claimWins = true;
  accountActive = true;
  answerGate = undefined;
  rowDelete = undefined;
  calls.length = 0;
  mirrored.length = 0;
  metered.length = 0;
  convex.length = 0;
  resetHeldReservationsForTests();
  spyOn(planLimits, "recordUsageSoon").mockImplementation(
    (accountId, usage, source): void => {
      metered.push(
        `${accountId} ${JSON.stringify(usage)} ${source?.projectId ?? "-"} ${source?.agentId ?? "-"} ${source?.workspaceId ?? "-"}`,
      );
    },
  );
  mockFetch(async (input, init): Promise<Response> => {
    const headers = new Headers(init?.headers);
    calls.push({
      method: init?.method ?? "GET",
      url: requestUrl(input),
      authorization: headers.get("Authorization"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    if (requestUrl(input).endsWith("/exec")) return Response.json(EXEC_OK);
    if (init?.method === "GET") return Response.json({ exists: true });

    return new Response(null, { status: 204 });
  });
  // `stored` is the one reservation row under the key.
  spyOn(runtime, "query").mockImplementation((async (): Promise<
    string | null
  > => {
    convex.push("get");

    return stored;
  }) as never);
  spyOn(runtime, "mutate").mockImplementation((async (
    name: string,
    args: { externalId: string; reservationKey: string },
  ): Promise<unknown> => {
    if (name === "deleteSandboxReservation") {
      convex.push("delete");
      mirrored.push(`delete ${args.reservationKey}`);
      if (rowDelete?.goneFirst) stored = null;
      await rowDelete?.opened;
      if (rowDelete) stored = null;

      return true;
    }
    convex.push("reserve");
    if (!accountActive) throw new Error("Account is not active: acct");
    // Claim-or-reuse: the stored id, else this one (or a racing winner's).
    stored ??= claimWins ? args.externalId : "winner-id";
    const id = stored;
    await (answerGate ?? Bun.sleep(1));

    return id;
  }) as never);
  spyOn(sandboxInstances, "upsertSandboxInstance").mockImplementation(
    async (_plane, _provider, key, _id, _meta, options): Promise<void> => {
      mirrored.push(`upsert ${key} ${options?.ephemeral === true}`);
    },
  );
});

afterEach((): void => {
  mock.restore();
  setSystemTime();
  delete process.env.CLOUDFLARE_WORKER_URL;
  delete process.env.CLOUDFLARE_WORKER_API_KEY;
});

it("runs an ephemeral command on an empty disk and keeps no row for it", async (): Promise<void> => {
  const result = await new WorkerSandboxExecutor(config).run({
    code: "echo ok",
    timeoutSeconds: 10,
    outputLimitBytes: 1024,
    envVars: { PATH: "/evil", CALL_VAR: "b" },
    args: ["one"],
    principal: { accountId: "acct", agentId: "agent", runToken: "tok" },
  });
  await settled();

  expect(result).toMatchObject({
    ok: true,
    stdout: "ok\n",
    provider: "worker",
  });
  expect(calls).toHaveLength(1);
  const [exec] = calls;
  expect(exec?.url).toMatch(
    /^https:\/\/worker\.example\.com\/v1\/sandboxes\/fp-e-[0-9a-f-]+\/exec$/,
  );
  expect(exec?.authorization).toBe("Bearer worker-key");
  expect(exec?.body).toEqual({
    script: "echo ok",
    args: ["one"],
    cwd: "/workspace",
    env: {
      ACCOUNT_VAR: "a",
      CALL_VAR: "b",
      BROODS_ACCOUNT_ID: "acct",
      BROODS_AGENT_ID: "agent",
      BROODS_RUN_TOKEN: "tok",
    },
    timeoutMs: 10_000,
    outputLimitBytes: 1024,
    enableInternet: false,
    persist: false,
  });
  expect(mirrored).toEqual([]);
});

it("meters each command's time and request to the account, its project, or the run's agent or workspace", async (): Promise<void> => {
  await new WorkerSandboxExecutor({
    ...config,
    controlPlane: { ...config.controlPlane!, projectId: "proj" },
  }).run(request);
  await new WorkerSandboxExecutor(config).run({
    ...request,
    metadata: { agentId: "agent-1" },
  });
  await new WorkerSandboxExecutor(config).run({
    ...request,
    metadata: { workspaceId: "ws-1" },
  });
  await new WorkerSandboxExecutor({ ...config, controlPlane: undefined }).run(
    request,
  );

  expect(metered).toEqual([
    'acct {"workerMs":5,"workerRequests":1} proj - -',
    'acct {"workerMs":5,"workerRequests":1} - agent-1 -',
    'acct {"workerMs":5,"workerRequests":1} - - ws-1',
  ]);
});

it("meters a command the Worker refused after running it, on its own clock", async (): Promise<void> => {
  mockFetch(
    async (): Promise<Response> =>
      new Response("another command changed the files", { status: 409 }),
  );

  await new WorkerSandboxExecutor({ ...config, persistent: true })
    .run(request)
    .catch((): void => {});

  expect(metered).toHaveLength(1);
  expect(metered[0]).toMatch(
    /^acct \{"workerMs":\d+,"workerRequests":1\} - - -$/,
  );
});

it("meters nothing for a call that never reached the Worker", async (): Promise<void> => {
  mockFetch(async (): Promise<Response> => {
    throw new TypeError("fetch failed");
  });

  await new WorkerSandboxExecutor(config).run(request).catch((): void => {});

  expect(metered).toEqual([]);
});

it("clamps the timeout to the Worker's ceiling, the one the config plane enforces, and turns internet on from the network mode", async (): Promise<void> => {
  await new WorkerSandboxExecutor({
    ...config,
    network: { mode: "allow-all" },
  }).run({ code: "true", timeoutSeconds: 600, outputLimitBytes: 1024 });

  expect(calls[0]?.body).toMatchObject({
    timeoutMs: MAX_TIMEOUT_MS,
    enableInternet: true,
  });
  expect(WORKER_MAX_TIMEOUT_SECONDS * 1000).toBe(MAX_TIMEOUT_MS);
});

it("reserves one persistent sandbox, keeps its files across runs and mirrors it", async (): Promise<void> => {
  const executor = new WorkerSandboxExecutor({ ...config, persistent: true });
  await executor.run(request);
  await executor.run(request);
  await settled();

  expect(calls.map((call): string => call.method)).toEqual(["POST", "POST"]);
  expect(calls[0]?.url).toBe(calls[1]?.url);
  expect(calls[0]?.url).toContain(`/v1/sandboxes/${stored}/exec`);
  expect(calls[0]?.body).toMatchObject({ persist: true });
  expect(mirrored).toEqual([
    "upsert acct:workspace false",
    "upsert acct:workspace false",
  ]);
});

it("books in one Convex call and holds the booking, so later commands make none", async (): Promise<void> => {
  const executor = new WorkerSandboxExecutor({ ...config, persistent: true });
  await executor.run(request);
  await executor.run(request);
  await executor.run(request);

  expect(convex).toEqual(["reserve"]);
  expect(new Set(execUrls())).toEqual(
    new Set([`https://worker.example.com/v1/sandboxes/${stored}/exec`]),
  );
});

it("runs two commands racing to book a new key on the winner's id", async (): Promise<void> => {
  await Promise.all([
    new WorkerSandboxExecutor({ ...config, persistent: true }).run(request),
    new WorkerSandboxExecutor({ ...config, persistent: true }).run(request),
  ]);

  expect(convex).toEqual(["reserve", "reserve"]);
  expect(execUrls()).toEqual([
    `https://worker.example.com/v1/sandboxes/${stored}/exec`,
    `https://worker.example.com/v1/sandboxes/${stored}/exec`,
  ]);
});

it("books a held reservation again once a minute, following a key repointed elsewhere", async (): Promise<void> => {
  const executor = new WorkerSandboxExecutor({ ...config, persistent: true });
  await executor.run(request);
  const first = stored;
  stored = "fp-p-other";
  await executor.run(request);
  spyOn(performance, "now").mockReturnValue(performance.now() + 61_000);
  await executor.run(request);
  await executor.run(request);

  expect(convex).toEqual(["reserve", "reserve"]);
  expect(execUrls()).toEqual([
    `https://worker.example.com/v1/sandboxes/${first}/exec`,
    `https://worker.example.com/v1/sandboxes/${first}/exec`,
    "https://worker.example.com/v1/sandboxes/fp-p-other/exec",
    "https://worker.example.com/v1/sandboxes/fp-p-other/exec",
  ]);
});

it("refuses a held reservation's next booking once the account is no longer active", async (): Promise<void> => {
  const executor = new WorkerSandboxExecutor({ ...config, persistent: true });
  await executor.run(request);
  accountActive = false;
  spyOn(performance, "now").mockReturnValue(performance.now() + 61_000);

  await expect(executor.run(request)).rejects.toThrow("Account is not active");
  expect(calls).toHaveLength(1);
});

it("books a held reservation again after a minute even if the wall clock is set back", async (): Promise<void> => {
  const executor = new WorkerSandboxExecutor({ ...config, persistent: true });
  await executor.run(request);
  setSystemTime(new Date(Date.now() - 3_600_000));
  spyOn(performance, "now").mockReturnValue(performance.now() + 61_000);
  await executor.run(request);

  expect(convex).toEqual(["reserve", "reserve"]);
});

it("lets go of a held reservation when it releases it", async (): Promise<void> => {
  const executor = new WorkerSandboxExecutor({ ...config, persistent: true });
  await executor.run(request);
  const first = stored;
  await executor.release({ reservationKey: request.reservationKey });
  stored = null;
  await executor.run(request);

  expect(convex).toEqual(["reserve", "get", "delete", "reserve"]);
  expect(execUrls().at(-1)).not.toContain(`/${first}/`);
});

it("lets go of a held reservation that any other path in core deletes", async (): Promise<void> => {
  const executor = new WorkerSandboxExecutor({ ...config, persistent: true });
  await executor.run(request);
  const first = stored;
  await deleteSandboxInstance("worker", request.reservationKey, "acct");
  stored = null;
  await executor.run(request);

  expect(convex).toEqual(["reserve", "delete", "reserve"]);
  expect(execUrls()[1]).not.toContain(`/${first}/`);
});

it("holds a booking only for the account that made it", async (): Promise<void> => {
  await new WorkerSandboxExecutor({ ...config, persistent: true }).run(request);
  await new WorkerSandboxExecutor({
    ...config,
    persistent: true,
    controlPlane: { ...config.controlPlane!, accountId: "acct-2" },
  }).run(request);

  expect(convex).toEqual(["reserve", "reserve"]);
});

it("drops the hold a command took on the old id while the release ran", async (): Promise<void> => {
  const executor = new WorkerSandboxExecutor({ ...config, persistent: true });
  await executor.run(request);
  const first = stored;
  const open = holdRowDelete(false);
  const releasing = executor.release({
    reservationKey: request.reservationKey,
  });
  await settled();
  await executor.run(request);
  open();
  await releasing;
  await executor.run(request);

  expect(convex).toEqual(["reserve", "get", "delete", "reserve", "reserve"]);
  expect(execUrls().slice(0, 2)).toEqual([
    `https://worker.example.com/v1/sandboxes/${first}/exec`,
    `https://worker.example.com/v1/sandboxes/${first}/exec`,
  ]);
  expect(execUrls()[2]).not.toContain(`/${first}/`);
});

it("books afresh, not from the hold, once a release took the row", async (): Promise<void> => {
  const executor = new WorkerSandboxExecutor({ ...config, persistent: true });
  await executor.run(request);
  const first = stored;
  const open = holdRowDelete(true);
  const releasing = executor.release({
    reservationKey: request.reservationKey,
  });
  await settled();
  await executor.run(request);
  open();
  await releasing;

  expect(convex).toEqual(["reserve", "get", "delete", "reserve"]);
  expect(execUrls()[1]).not.toContain(`/${first}/`);
});

it("does not hold a booking that was in flight across a release", async (): Promise<void> => {
  stored = "fp-p-old";
  let answer = (): void => {};
  answerGate = new Promise<void>((resolve): void => {
    answer = resolve;
  });
  const executor = new WorkerSandboxExecutor({ ...config, persistent: true });
  const booking = executor.run(request);
  await settled();
  await executor.release({ reservationKey: request.reservationKey });
  stored = null;
  answerGate = undefined;
  answer();
  await booking;
  await executor.run(request);

  expect(convex).toEqual(["reserve", "get", "delete", "reserve"]);
  expect(execUrls()).toHaveLength(2);
  expect(execUrls()[0]).toContain("/fp-p-old/");
  expect(execUrls()[1]).not.toContain("/fp-p-old/");
});

it("runs commands on one reservation one at a time, so none starts from stale files", async (): Promise<void> => {
  const inFlight: string[] = [];
  let peak = 0;
  mockFetch(async (input): Promise<Response> => {
    inFlight.push(requestUrl(input));
    peak = Math.max(peak, inFlight.length);
    await Bun.sleep(5);
    inFlight.pop();

    return Response.json(EXEC_OK);
  });
  const executor = new WorkerSandboxExecutor({ ...config, persistent: true });

  await Promise.all([executor.run(request), executor.run(request)]);

  expect(peak).toBe(1);
});

it("surfaces the Worker's refusal of a command that lost a race as a plain error", async (): Promise<void> => {
  mockFetch(
    async (): Promise<Response> =>
      new Response("another command changed the files", { status: 409 }),
  );

  const failure = await new WorkerSandboxExecutor({
    ...config,
    persistent: true,
  })
    .run(request)
    .then(
      (): string => "ran",
      (error: unknown): string => String(error),
    );
  await settled();

  expect(failure).toContain("failed (409): another command changed the files");
  expect(mirrored).toEqual([]);
});

it("takes the winner's id when it loses the reservation race", async (): Promise<void> => {
  claimWins = false;
  await new WorkerSandboxExecutor({ ...config, persistent: true }).run(request);

  expect(calls[0]?.url).toContain("/v1/sandboxes/winner-id/exec");
});

it("runs a persistent config with no account and no reservation as ephemeral", async (): Promise<void> => {
  await new WorkerSandboxExecutor({
    ...config,
    persistent: true,
    controlPlane: undefined,
  }).run(request);

  expect(calls[0]?.url).toContain("/v1/sandboxes/fp-e-");
  expect(calls[0]?.body).toMatchObject({ persist: false });
  expect(convex).toEqual(["get"]);
});

it("reuses an existing reservation without an account by key alone, and never claims one", async (): Promise<void> => {
  stored = "fp-p-existing";
  const executor = new WorkerSandboxExecutor({
    ...config,
    persistent: true,
    controlPlane: undefined,
  });
  await executor.run(request);
  await executor.run(request);

  expect(convex).toEqual(["get", "get"]);
  expect(execUrls()).toEqual([
    "https://worker.example.com/v1/sandboxes/fp-p-existing/exec",
    "https://worker.example.com/v1/sandboxes/fp-p-existing/exec",
  ]);
});

it("reports stored files as a kept sandbox and drops them on release", async (): Promise<void> => {
  stored = "fp-p-existing";
  const executor = new WorkerSandboxExecutor({ ...config, persistent: true });

  expect(await executor.getInstanceInfo(request)).toEqual({
    externalId: "fp-p-existing",
    state: "suspended",
  });
  await executor.release(request);

  expect(calls.map((call): string => `${call.method} ${call.url}`)).toEqual([
    "GET https://worker.example.com/v1/sandboxes/fp-p-existing",
    "DELETE https://worker.example.com/v1/sandboxes/fp-p-existing",
  ]);
  expect(mirrored).toEqual(["delete acct:workspace"]);
});

it("refuses a workspace mount and a plain-HTTP Worker outside loopback", (): void => {
  expect(
    (): WorkerSandboxExecutor =>
      new WorkerSandboxExecutor({
        ...config,
        storage: { provider: "s3", bucket: "b" } as never,
      }),
  ).toThrow("cannot mount workspaces");
  process.env.CLOUDFLARE_WORKER_URL = "http://worker.example.com";
  expect(workerConnection).toThrow("must be https outside loopback");
  process.env.CLOUDFLARE_WORKER_URL = "http://127.0.0.1:8787/";
  expect(workerConnection().baseURL).toBe("http://127.0.0.1:8787");
});

function mockFetch(
  handler: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
): void {
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(handler, { preconnect: (): void => {} }),
  );
}

function holdRowDelete(goneFirst: boolean): () => void {
  let open = (): void => {};
  rowDelete = {
    opened: new Promise<void>((resolve): void => {
      open = resolve;
    }),
    goneFirst: goneFirst,
  };

  return open;
}

function execUrls(): string[] {
  return calls
    .filter((call): boolean => call.url.endsWith("/exec"))
    .map((call): string => call.url);
}

async function settled(): Promise<void> {
  await new Promise((resolve): void => {
    setTimeout(resolve, 0);
  });
}
