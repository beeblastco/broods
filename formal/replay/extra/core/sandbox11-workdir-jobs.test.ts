import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { WorkdirSandboxExecutor } from "../../../../apps/core/src/harness/sandbox/workdir-executor.ts";
import * as instanceStore from "../../../../apps/core/src/harness/sandbox/instance-store.ts";
import type { SandboxExecutorConfig } from "../../../../apps/core/src/harness/sandbox/types.ts";
import * as sandboxInstances from "../../../../apps/core/src/shared/convex/sandbox-instances.ts";

type Spy = { mockRestore: () => void };

const realFetch = globalThis.fetch;
const KEY = "tool:acct_1";
let spies: Spy[] = [];
let calls: string[] = [];
let execOutputs: string[] = [];
let createStatus = 201;
let getStatus = 200;
let deleteStatus = 200;
let createdBodies: Array<Record<string, unknown>> = [];
let getState = "running";
let execExit = 0;
let snapshotBody: Record<string, unknown> = {};

function reply(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status: status,
    text: async (): Promise<string> => JSON.stringify(payload),
  } as unknown as Response;
}

function sandboxObject(id: string, state = "running"): Record<string, unknown> {
  return {
    id: id,
    runtime: "firecracker",
    image: "base",
    state: state,
    resources: { cpu: "1 shared vCPU", memory_mb: 2048, disk_gb: 8 },
    boot_path: "hot_pool",
    urls: { ports: {} },
    mounts: [],
    volumes: [],
    network: { egress: "default" },
  };
}

async function fakeFetch(
  url: string | URL,
  init?: RequestInit,
): Promise<Response> {
  const path = String(url).replace(/^https?:\/\/[^/]+/, "");
  const method = (init?.method ?? "GET").toUpperCase();
  calls.push(`${method} ${path}`);
  if (method === "POST" && path === "/v1/sandboxes") {
    createdBodies.push(
      JSON.parse(init?.body as string) as Record<string, unknown>,
    );

    return createStatus < 300
      ? reply(sandboxObject("sbx_new"), createStatus)
      : reply({ error: { code: "x", message: "refused" } }, createStatus);
  }
  if (method === "GET") {
    return getStatus < 300
      ? reply(sandboxObject(path.split("/").pop() ?? "", getState))
      : reply({ error: { code: "x", message: "lookup failed" } }, getStatus);
  }
  if (method === "POST" && path.endsWith("/exec")) {
    return reply({
      exit_code: execExit,
      stdout: execOutputs.shift() ?? "ok\n",
      stderr: execExit === 0 ? "" : "launch refused",
    });
  }
  if (method === "POST" && path.endsWith("/snapshot"))
    return reply(snapshotBody);
  if (method === "DELETE") {
    return deleteStatus < 300
      ? reply({})
      : reply({ error: { code: "x", message: "delete failed" } }, deleteStatus);
  }

  return reply({ error: { code: "not_found", message: path } }, 404);
}

function config(
  extra: Partial<SandboxExecutorConfig> = {},
): SandboxExecutorConfig {
  return {
    provider: "sandbox",
    persistent: true,
    options: { workdirUrl: "https://workdir.test", apiKey: "k" },
    ...extra,
  } as SandboxExecutorConfig;
}

function stored(id: string | undefined): void {
  spies.push(
    spyOn(instanceStore, "getSandboxExternalId").mockResolvedValue(
      id as string,
    ),
  );
}

let claim: ReturnType<
  typeof spyOn<typeof instanceStore, "claimSandboxInstance">
>;
let removeRow: ReturnType<
  typeof spyOn<typeof instanceStore, "deleteSandboxInstance">
>;

beforeEach((): void => {
  globalThis.fetch = fakeFetch as unknown as typeof fetch;
  calls = [];
  execOutputs = [];
  createStatus = 201;
  getStatus = 200;
  deleteStatus = 200;
  createdBodies = [];
  getState = "running";
  execExit = 0;
  snapshotBody = {};
  claim = spyOn(instanceStore, "claimSandboxInstance").mockResolvedValue(true);
  removeRow = spyOn(instanceStore, "deleteSandboxInstance").mockResolvedValue(
    undefined,
  );
  spies = [
    claim,
    removeRow,
    spyOn(instanceStore, "getSandboxReservationRecord").mockResolvedValue(null),
    spyOn(instanceStore, "saveSandboxInstance").mockResolvedValue(undefined),
    spyOn(sandboxInstances, "upsertSandboxInstance").mockResolvedValue(
      undefined,
    ),
  ];
});

afterEach((): void => {
  globalThis.fetch = realFetch;
  for (const spy of spies) spy.mockRestore();
});

const reserved = (): ReturnType<typeof spyOn> =>
  spyOn(instanceStore, "getSandboxReservationRecord").mockResolvedValue({
    externalId: "sbx_old",
    claimedAt: Date.now(),
  } as never);

const ref = { jobId: "job_1", reservationKey: KEY };

describe("workdir job calls", () => {
  test("reads a job's status, logs and stop", async (): Promise<void> => {
    const executor = new WorkdirSandboxExecutor(config());
    stored("sbx_stored");

    execOutputs = ["done 0\n"];
    expect(await executor.jobStatus(ref)).toEqual({
      jobId: "job_1",
      state: "completed",
      exitCode: 0,
    });

    execOutputs = ["line one\n"];
    expect(await executor.jobLogs(ref)).toEqual({
      jobId: "job_1",
      logs: "line one\n",
      truncated: false,
    });

    execOutputs = ["", "done 137\n"];
    expect(await executor.stopJob(ref)).toEqual({
      jobId: "job_1",
      state: "failed",
      exitCode: 137,
    });
  });

  test("a job call needs a reservation key", async (): Promise<void> => {
    await expect(
      new WorkdirSandboxExecutor(config()).jobStatus({ jobId: "job_1" }),
    ).rejects.toThrow(
      "job operations require a persistent sandbox reservation key",
    );
  });

  test("a job call needs a stored reservation", async (): Promise<void> => {
    stored(undefined);

    await expect(
      new WorkdirSandboxExecutor(config()).jobLogs(ref),
    ).rejects.toThrow("no reserved workdir sandbox for this workspace");
  });
});

describe("workdir acquire race", () => {
  const launch = (
    executor: WorkdirSandboxExecutor,
  ): ReturnType<WorkdirSandboxExecutor["runBackground"]> =>
    executor.runBackground({
      code: "echo hi",
      reservationKey: KEY,
      timeoutSeconds: 30,
      outputLimitBytes: 1024,
      jobId: "job_1",
    });

  test("connects to the winner, and logs when dropping its own sandbox fails", async (): Promise<void> => {
    claim.mockResolvedValue(false);
    stored("sbx_winner");
    deleteStatus = 500;

    const handle = await launch(new WorkdirSandboxExecutor(config()));

    expect(handle.externalId).toBe("sbx_winner");
    expect(calls).toContain("DELETE /v1/sandboxes/sbx_new");
  });

  test("fails when the claim is lost and no winner row exists", async (): Promise<void> => {
    claim.mockResolvedValue(false);
    stored(undefined);

    await expect(launch(new WorkdirSandboxExecutor(config()))).rejects.toThrow(
      "lost create race",
    );
  });

  test("undoes both sides when the claim call fails", async (): Promise<void> => {
    claim.mockRejectedValue(new Error("claim exploded"));

    await expect(launch(new WorkdirSandboxExecutor(config()))).rejects.toThrow(
      "claim exploded",
    );
    expect(calls).toContain("DELETE /v1/sandboxes/sbx_new");
    expect(removeRow).toHaveBeenCalledTimes(1);
  });
});

describe("workdir release", () => {
  const executor = (): WorkdirSandboxExecutor =>
    new WorkdirSandboxExecutor(config());

  test("ignores a request with no reservation key", async (): Promise<void> => {
    await executor().release({});
    expect(calls).toEqual([]);
  });

  test("ignores a reservation with no stored sandbox", async (): Promise<void> => {
    stored(undefined);
    await executor().release({ reservationKey: KEY });
    expect(calls).toEqual([]);
  });

  test("still drops the row when the sandbox is already gone", async (): Promise<void> => {
    getStatus = 404;

    await executor().release({ reservationKey: KEY, expectedExternalId: "x" });

    expect(removeRow).toHaveBeenCalledTimes(1);
  });

  test("rethrows a release failure that is not a gone sandbox", async (): Promise<void> => {
    getStatus = 500;

    await expect(
      executor().release({ reservationKey: KEY, expectedExternalId: "x" }),
    ).rejects.toThrow();
    expect(removeRow).toHaveBeenCalledTimes(0);
  });
});

describe("workdir S3 secrets", () => {
  const withNames = (names: unknown): WorkdirSandboxExecutor =>
    new WorkdirSandboxExecutor(
      config({
        persistent: false,
        options: {
          workdirUrl: "https://workdir.test",
          apiKey: "k",
          mountAwsS3Buckets: true,
          workspaceBucketName: "bkt",
          s3SecretNames: names,
        },
      }),
    );
  const run = (
    executor: WorkdirSandboxExecutor,
  ): ReturnType<WorkdirSandboxExecutor["run"]> =>
    executor.run({
      code: "ls",
      namespace: "ns-1",
      timeoutSeconds: 30,
      outputLimitBytes: 1024,
    });

  test("names only the usable secrets the account configured", async (): Promise<void> => {
    await run(withNames(["MY_KEY", "  ", 5, "MY_SECRET"]));

    expect(
      (createdBodies[0]?.startup as { secrets: string[] }).secrets,
    ).toEqual(["MY_KEY", "MY_SECRET"]);
  });

  test("falls back to the default names when none are usable", async (): Promise<void> => {
    await run(withNames(["  "]));

    expect(
      (createdBodies[0]?.startup as { secrets: string[] }).secrets,
    ).toEqual(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]);
  });
});

describe("workdir reserved sandbox edge cases", () => {
  const executor = (
    extra: Partial<SandboxExecutorConfig> = {},
  ): WorkdirSandboxExecutor => new WorkdirSandboxExecutor(config(extra));

  test("keeps a reserved sandbox on a transient lookup error", async (): Promise<void> => {
    spies.push(reserved());
    getStatus = 500;

    await expect(
      executor().run({
        code: "echo hi",
        reservationKey: KEY,
        timeoutSeconds: 30,
        outputLimitBytes: 1024,
      }),
    ).rejects.toThrow();
    expect(calls).not.toContain("POST /v1/sandboxes");
  });

  test("reports what a failed job launch printed", async (): Promise<void> => {
    execExit = 3;

    await expect(
      executor().runBackground({
        code: "echo hi",
        reservationKey: KEY,
        timeoutSeconds: 30,
        outputLimitBytes: 1024,
        jobId: "job_1",
      }),
    ).rejects.toThrow("launch refused");
  });

  test("refuses to snapshot a request with no reservation", async (): Promise<void> => {
    await expect(executor().snapshot({})).rejects.toThrow(
      "no reserved workdir sandbox to snapshot",
    );
  });

  test("refuses a snapshot that came back without an id", async (): Promise<void> => {
    stored("sbx_stored");

    await expect(executor().snapshot({ reservationKey: KEY })).rejects.toThrow(
      "did not return an id",
    );
  });

  test("returns the snapshot id and image", async (): Promise<void> => {
    stored("sbx_stored");
    snapshotBody = { id: "snap_1", image_id: "img_1" };

    expect(await executor().snapshot({ reservationKey: KEY })).toEqual({
      snapshotId: "snap_1",
      externalImageId: "img_1",
    });
  });

  test("reports an unrecognised state as unknown and a missing sandbox as terminating", async (): Promise<void> => {
    stored("sbx_stored");
    getState = "mystery";
    expect(
      await executor().getInstanceInfo({ reservationKey: KEY }),
    ).toMatchObject({
      externalId: "sbx_stored",
      state: "unknown",
    });

    getStatus = 404;
    expect(await executor().getInstanceInfo({ reservationKey: KEY })).toEqual({
      externalId: "sbx_stored",
      state: "terminating",
    });
  });

  test("blocks all egress for a restricted network with no allow entries", async (): Promise<void> => {
    await executor({
      persistent: false,
      network: { mode: "restricted" },
    }).run({
      code: "echo hi",
      timeoutSeconds: 30,
      outputLimitBytes: 1024,
    });

    expect((createdBodies[0]?.startup as { network: unknown }).network).toEqual(
      { egress: "none" },
    );
  });
});
