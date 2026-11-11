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
import * as s3Mount from "../../../../apps/core/src/harness/sandbox/s3-mount.ts";
import type { SandboxExecutorConfig } from "../../../../apps/core/src/harness/sandbox/types.ts";
import * as sandboxInstances from "../../../../apps/core/src/shared/convex/sandbox-instances.ts";
import { drainInFlight } from "../../../../apps/core/src/shared/in-flight.ts";

const IMAGE = "arn:aws:lambda:us-east-1:123456789012:microvm-image:sandbox";
const ENDPOINT = "microvm-1.lambda-microvm.us-east-1.on.aws";
const EXEC_BODY = {
  ok: true,
  runtime: "bash",
  exit_code: 0,
  timed_out: false,
  duration_ms: 5,
  stdout: "shell ok\n",
  stderr: "",
  truncated: false,
};

const envBefore = { ...process.env };
const fetchBefore = globalThis.fetch;
const sent: string[] = [];
let getState = "RUNNING";
let getImage = IMAGE;
let getEndpoint: string | undefined = ENDPOINT;
let flaky = 0;
let execBody: Record<string, unknown> = EXEC_BODY;
let execStatus = 200;
let mountLive = true;

const client = {
  send: async (command: object): Promise<Record<string, unknown>> => {
    sent.push(command.constructor.name);
    if (command instanceof RunMicrovmCommand) {
      return { microvmId: "microvm-1", endpoint: ENDPOINT, state: "PENDING" };
    }
    if (command instanceof CreateMicrovmAuthTokenCommand) {
      return { authToken: { "X-aws-proxy-auth": "proxy-token" } };
    }
    if (command instanceof GetMicrovmCommand) {
      return {
        imageArn: getImage,
        endpoint: getEndpoint,
        state: getState,
        microvmId: "microvm-1",
      };
    }
    if (command instanceof ResumeMicrovmCommand) {
      getState = "RUNNING";

      return {};
    }
    if (command instanceof TerminateMicrovmCommand) return {};

    return {};
  },
} as unknown as LambdaMicrovms;

function executor(
  config: Partial<SandboxExecutorConfig>,
): MicrovmSandboxExecutor {
  return new MicrovmSandboxExecutor(
    { provider: "lambda", ...config } as SandboxExecutorConfig,
    client,
  );
}

function fakeFetch(): typeof fetch {
  return Object.assign(
    async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const target = url instanceof Request ? url.url : url.toString();
      if (target.endsWith("/healthz")) return new Response("ok");
      if (target.endsWith("/workspace/credentials")) return new Response("{}");
      if (flaky > 0) {
        flaky -= 1;

        return new Response("warming", { status: 503 });
      }
      const sent = typeof init?.body === "string" ? init.body : "";
      const mounted = sent.includes("mountpoint -q ");
      const body = mounted
        ? { ...execBody, ok: mountLive, exit_code: mountLive ? 0 : 1 }
        : execBody;

      return new Response(JSON.stringify(body), {
        status: execStatus,
        headers: { "content-type": "application/json" },
      });
    },
    { preconnect: fetchBefore.preconnect },
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
  sent.length = 0;
  getState = "RUNNING";
  getImage = IMAGE;
  getEndpoint = ENDPOINT;
  flaky = 0;
  execBody = EXEC_BODY;
  execStatus = 200;
  mountLive = true;
});

const request = {
  code: "echo ok",
  timeoutSeconds: 30,
  outputLimitBytes: 4096,
};
const plane = { accountId: "acct_1" };

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
  spyOn(s3Mount, "resolveS3Mount").mockResolvedValue({
    bucket: "workspace-bucket",
    prefix: "ns/",
  });
}

describe("MicroVM run", () => {
  test("a one-off VM runs the command and is terminated", async (): Promise<void> => {
    stores(null);
    const result = await executor({ controlPlane: plane }).run(request);
    await drainInFlight();
    expect(result.stdout).toBe("shell ok\n");
    expect(sent).toEqual([
      "RunMicrovmCommand",
      "CreateMicrovmAuthTokenCommand",
      "TerminateMicrovmCommand",
    ]);
  });

  test("a one-off VM is retried while the proxy answers 503", async (): Promise<void> => {
    stores(null);
    flaky = 1;
    const result = await executor({}).run(request);
    await drainInFlight();
    expect(result.exitCode).toBe(0);
  });

  test("a failing exec raises and still terminates the VM", async (): Promise<void> => {
    stores(null);
    execStatus = 500;
    await expect(executor({}).run(request)).rejects.toThrow("failed (500)");
    await drainInFlight();
    expect(sent.at(-1)).toBe("TerminateMicrovmCommand");
  });

  test("a reserved VM is created once, then reused from the cache", async (): Promise<void> => {
    stores(null);
    const config = {
      persistent: true,
      controlPlane: plane,
      onCreate: ["echo setup"],
    };
    const first = await executor(config).run({
      ...request,
      reservationKey: "rk-14a",
    });
    const second = await executor(config).run({
      ...request,
      reservationKey: "rk-14a",
    });
    await drainInFlight();
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(sent.filter((name) => name === "RunMicrovmCommand")).toHaveLength(1);
  });

  test("a reserved workspace mounts on first create and checks the mount", async (): Promise<void> => {
    stores(null);
    const namespace = "fs-0123456789abcdef0123456789abcdef01234514";
    const result = await executor({
      persistent: true,
      controlPlane: plane,
    }).run({
      ...request,
      namespace: namespace,
      workspaceRoot: "/mnt/workspaces",
    });
    await drainInFlight();
    expect(result.ok).toBe(true);
  });

  test("an existing reservation reconnects and resumes a suspended VM", async (): Promise<void> => {
    stores("microvm-1");
    getState = "SUSPENDED";
    const result = await executor({
      persistent: true,
      controlPlane: plane,
    }).run({
      ...request,
      reservationKey: "rk-14b",
    });
    await drainInFlight();
    expect(result.ok).toBe(true);
    expect(sent).toContain("ResumeMicrovmCommand");
  });

  test("a VM running another image is terminated and recreated", async (): Promise<void> => {
    stores("microvm-1");
    getImage = "arn:aws:lambda:us-east-1:123456789012:microvm-image:other";
    const result = await executor({
      persistent: true,
      controlPlane: plane,
    }).run({
      ...request,
      reservationKey: "rk-14c",
    });
    await drainInFlight();
    expect(result.ok).toBe(true);
    expect(sent).toContain("TerminateMicrovmCommand");
  });
});
