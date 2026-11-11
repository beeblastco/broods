import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";

import type { LambdaMicrovms } from "../../../../apps/core/node_modules/@aws-sdk/client-lambda-microvms";
import {
  CreateMicrovmAuthTokenCommand,
  GetMicrovmCommand,
  ResumeMicrovmCommand,
  RunMicrovmCommand,
  TerminateMicrovmCommand,
} from "../../../../apps/core/node_modules/@aws-sdk/client-lambda-microvms";
import * as instanceStore from "../../../../apps/core/src/harness/sandbox/instance-store.ts";
import { MicrovmSandboxExecutor } from "../../../../apps/core/src/harness/sandbox/microvm-executor.ts";
import type { SandboxExecutorConfig } from "../../../../apps/core/src/harness/sandbox/types.ts";
import * as sandboxInstances from "../../../../apps/core/src/shared/convex/sandbox-instances.ts";
import { drainInFlight } from "../../../../apps/core/src/shared/in-flight.ts";

const IMAGE = "arn:aws:lambda:us-east-1:123456789012:microvm-image:sandbox";
const ENDPOINT = "microvm-1.lambda-microvm.us-east-1.on.aws";

const envBefore = { ...process.env };
const fetchBefore = globalThis.fetch;
let execStdout = "harness command\n";
let execTruncated = false;
let execExit = 0;
let healthy = true;

const client = {
  send: async (command: object): Promise<Record<string, unknown>> => {
    if (command instanceof RunMicrovmCommand) {
      return { microvmId: "microvm-1", endpoint: ENDPOINT, state: "PENDING" };
    }
    if (command instanceof CreateMicrovmAuthTokenCommand) {
      return { authToken: { "X-aws-proxy-auth": "proxy-token" } };
    }
    if (command instanceof GetMicrovmCommand) {
      return {
        imageArn: IMAGE,
        endpoint: ENDPOINT,
        state: "RUNNING",
        microvmId: "microvm-1",
      };
    }
    if (
      command instanceof ResumeMicrovmCommand ||
      command instanceof TerminateMicrovmCommand
    ) {
      return {};
    }

    return {};
  },
} as unknown as LambdaMicrovms;

function executor(
  config: Partial<SandboxExecutorConfig>,
): MicrovmSandboxExecutor {
  return new MicrovmSandboxExecutor(
    {
      provider: "lambda",
      persistent: true,
      ...config,
    } as SandboxExecutorConfig,
    client,
  );
}

function fakeFetch(): typeof fetch {
  return Object.assign(
    async (url: string | URL | Request): Promise<Response> => {
      const target = url instanceof Request ? url.url : url.toString();
      if (target.endsWith("/healthz")) {
        return healthy
          ? new Response("ok")
          : new Response("starting", { status: 503 });
      }
      if (target.endsWith("/guest/route")) {
        return new Response(JSON.stringify({ routed: true }), {
          headers: {
            "x-sandbox-burst": JSON.stringify({
              vcpu_seconds: 2,
              gb_seconds: 1,
            }),
          },
        });
      }

      return new Response(
        JSON.stringify({
          ok: true,
          runtime: "bash",
          exit_code: execExit,
          timed_out: false,
          duration_ms: 5,
          stdout: execStdout,
          stderr: "",
          truncated: execTruncated,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
    { preconnect: fetchBefore.preconnect },
  );
}

function stores(external: string | null): void {
  spyOn(instanceStore, "getSandboxExternalId").mockResolvedValue(external);
  spyOn(instanceStore, "claimSandboxInstance").mockResolvedValue(true);
  spyOn(instanceStore, "saveSandboxInstance").mockResolvedValue(
    undefined as never,
  );
  spyOn(instanceStore, "deleteSandboxInstance").mockResolvedValue(true);
  spyOn(sandboxInstances, "upsertSandboxInstance").mockResolvedValue(
    undefined as never,
  );
  spyOn(sandboxInstances, "recordSandboxBurst").mockResolvedValue(true);
  spyOn(sandboxInstances, "removeSandboxInstance").mockResolvedValue(
    undefined as never,
  );
}

beforeAll((): void => {
  process.env.AWS_REGION = "us-east-1";
  process.env.MICROVM_IMAGE_IDENTIFIER = IMAGE;
  process.env.MICROVM_EXECUTION_ROLE_ARN =
    "arn:aws:iam::123456789012:role/microvm-execution";
  process.env.MICROVM_LOG_GROUP_NAME = "/broods/dev/microvms";
  process.env.MICROVM_EGRESS_NETWORK_CONNECTOR_ARN =
    "arn:aws:lambda:us-east-1:123456789012:network-connector:vpc-egress";
  globalThis.fetch = fakeFetch();
});

afterAll((): void => {
  process.env = envBefore;
  globalThis.fetch = fetchBefore;
});

afterEach(async (): Promise<void> => {
  await drainInFlight();
  execStdout = "harness command\n";
  execTruncated = false;
  execExit = 0;
  healthy = true;
});

describe("MicroVM harness reservations", () => {
  test("a new reservation creates the VM and runs its lifecycle hooks", async (): Promise<void> => {
    stores(null);
    const reservation = await executor({
      onCreate: ["mkdir -p /workspace"],
    }).acquireHarnessReservation({
      reservationKey: "acct:agent:h14a",
    });
    expect(reservation).toEqual({
      microvmId: "microvm-1",
      endpoint: ENDPOINT,
      isFirstCreate: true,
    });
  });

  test("a failing lifecycle hook releases a VM this call created", async (): Promise<void> => {
    stores(null);
    // The store knows the VM once it is claimed, as in production.
    spyOn(instanceStore, "getSandboxExternalId")
      .mockResolvedValueOnce(null)
      .mockResolvedValue("microvm-1");
    execExit = 1;
    await expect(
      executor({ onCreate: ["false"] }).acquireHarnessReservation({
        reservationKey: "acct:agent:h14b",
      }),
    ).rejects.toThrow();
    expect(instanceStore.deleteSandboxInstance).toHaveBeenCalled();
  });

  test("a key that is not a persistent reservation is refused", async (): Promise<void> => {
    stores(null);
    await expect(
      executor({ persistent: false }).acquireHarnessReservation({
        reservationKey: "acct:agent:h14c",
      }),
    ).rejects.toThrow("persistent");
  });

  test("an existing reservation is resumed", async (): Promise<void> => {
    stores("microvm-1");
    const reservation = await executor({
      envVars: { CONFIGURED: "base" },
    }).resumeHarnessReservation({
      reservationKey: "acct:agent:h14d",
    });
    expect(reservation).toEqual({ microvmId: "microvm-1", endpoint: ENDPOINT });
  });

  test("a reservation with no VM cannot be resumed", async (): Promise<void> => {
    stores(null);
    await expect(
      executor({}).resumeHarnessReservation({
        reservationKey: "acct:agent:h14e",
      }),
    ).rejects.toThrow("no reserved MicroVM");
  });
});

describe("MicroVM harness commands", () => {
  const target = {
    microvmId: "microvm-1",
    endpoint: ENDPOINT,
    reservationKey: "acct:agent:h14f",
    code: "echo hi",
  };

  test("a command returns its output", async (): Promise<void> => {
    stores(null);
    const result = await executor({}).runHarnessCommand(target);
    expect(result).toEqual({
      stdout: "harness command\n",
      stderr: "",
      exitCode: 0,
    });
  });

  test("output past the exec cap is refused", async (): Promise<void> => {
    stores(null);
    execTruncated = true;
    await expect(executor({}).runHarnessCommand(target)).rejects.toThrow(
      "exec cap",
    );
  });
});

describe("MicroVM background jobs", () => {
  const request = { jobId: "job_14a", reservationKey: "acct:agent:h14g" };

  test("a job is launched, polled, read and stopped", async (): Promise<void> => {
    stores("microvm-1");
    const vm = executor({});
    const handle = await vm.runBackground({
      code: "sleep 1",
      reservationKey: "acct:agent:h14g",
      timeoutSeconds: 30,
      outputLimitBytes: 4096,
      jobId: "job_14a",
    });
    expect(handle).toEqual({ jobId: "job_14a", externalId: "microvm-1" });
    execStdout = "running\n";
    expect((await vm.jobStatus(request)).state).toBe("running");
    execStdout = "line one\nline two\n";
    expect(
      (await vm.jobLogs({ ...request, outputLimitBytes: 8 })).truncated,
    ).toBe(true);
    execStdout = "done 143\n";
    expect((await vm.stopJob(request)).state).toBe("failed");
  });

  test("a launch the guest refuses is an error", async (): Promise<void> => {
    stores("microvm-1");
    execExit = 1;
    await expect(
      executor({}).runBackground({
        code: "sleep 1",
        reservationKey: "acct:agent:h14h",
        timeoutSeconds: 30,
        outputLimitBytes: 4096,
      }),
    ).rejects.toThrow();
  });

  test("job calls need a reservation key", async (): Promise<void> => {
    stores("microvm-1");
    await expect(executor({}).jobStatus({ jobId: "job_14b" })).rejects.toThrow(
      "reservation key",
    );
  });

  test("background jobs need a persistent sandbox", async (): Promise<void> => {
    stores("microvm-1");
    await expect(
      executor({ persistent: false }).runBackground({
        code: "sleep 1",
        reservationKey: "acct:agent:h14i",
        timeoutSeconds: 30,
        outputLimitBytes: 4096,
      }),
    ).rejects.toThrow("persistent");
  });
});

describe("MicroVM guest routes", () => {
  const route = {
    path: "/guest/route",
    body: { ping: true },
    timeoutMs: 5000,
    reservationKey: "acct:agent:h14j",
  };

  test("a route creates the VM once, then reuses it from the cache", async (): Promise<void> => {
    stores(null);
    const first = await executor({
      controlPlane: { accountId: "acct_1" },
    }).postReserved(route);
    const second = await executor({
      controlPlane: { accountId: "acct_1" },
    }).postReserved(route);
    expect(first).toEqual({ routed: true });
    expect(second).toEqual({ routed: true });
  });

  test("a route needs a persistent sandbox", async (): Promise<void> => {
    stores(null);
    await expect(
      executor({ persistent: false }).postReserved(route),
    ).rejects.toThrow("persistent");
  });
});
