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
  CreateMicrovmShellAuthTokenCommand,
  GetMicrovmCommand,
  RunMicrovmCommand,
} from "../../../../apps/core/node_modules/@aws-sdk/client-lambda-microvms";
import * as instanceStore from "../../../../apps/core/src/harness/sandbox/instance-store.ts";
import {
  MicrovmSandboxExecutor,
  microvmShellConnection,
} from "../../../../apps/core/src/harness/sandbox/microvm-executor.ts";
import type { SandboxExecutorConfig } from "../../../../apps/core/src/harness/sandbox/types.ts";
import * as sandboxInstances from "../../../../apps/core/src/shared/convex/sandbox-instances.ts";
import { drainInFlight } from "../../../../apps/core/src/shared/in-flight.ts";

const IMAGE = "arn:aws:lambda:us-east-1:123456789012:microvm-image:sandbox";
const ENDPOINT = "microvm-1.lambda-microvm.us-east-1.on.aws";

const envBefore = { ...process.env };
const fetchBefore = globalThis.fetch;
let vmState: string | undefined = "RUNNING";
let shellToken: Record<string, string> | undefined = {
  "X-aws-proxy-auth": "shell-token",
};
let routeResponse: () => Response = (): Response => new Response("{}");

const client = {
  send: async (command: object): Promise<Record<string, unknown>> => {
    if (command instanceof RunMicrovmCommand) {
      return { microvmId: "microvm-1", endpoint: ENDPOINT, state: "PENDING" };
    }
    if (command instanceof CreateMicrovmAuthTokenCommand) {
      return { authToken: { "X-aws-proxy-auth": "proxy-token" } };
    }
    if (command instanceof CreateMicrovmShellAuthTokenCommand) {
      return { authToken: shellToken };
    }
    if (command instanceof GetMicrovmCommand) {
      return {
        imageArn: IMAGE,
        endpoint: ENDPOINT,
        state: vmState,
        microvmId: "microvm-1",
      };
    }

    return {};
  },
} as unknown as LambdaMicrovms;

function executor(
  config: Partial<SandboxExecutorConfig> = {},
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
  globalThis.fetch = Object.assign(
    async (url: string | URL | Request): Promise<Response> => {
      const target = url instanceof Request ? url.url : url.toString();

      return target.endsWith("/healthz") ? new Response("ok") : routeResponse();
    },
    { preconnect: fetchBefore.preconnect },
  );
});

afterAll((): void => {
  process.env = envBefore;
  globalThis.fetch = fetchBefore;
});

afterEach(async (): Promise<void> => {
  await drainInFlight();
  process.env = { ...envBefore, ...baseEnv() };
  vmState = "RUNNING";
  shellToken = { "X-aws-proxy-auth": "shell-token" };
  routeResponse = (): Response => new Response("{}");
});

function baseEnv(): Record<string, string> {
  return {
    AWS_REGION: "us-east-1",
    MICROVM_IMAGE_IDENTIFIER: IMAGE,
    MICROVM_EXECUTION_ROLE_ARN:
      "arn:aws:iam::123456789012:role/microvm-execution",
    MICROVM_LOG_GROUP_NAME: "/broods/dev/microvms",
    MICROVM_EGRESS_NETWORK_CONNECTOR_ARN:
      "arn:aws:lambda:us-east-1:123456789012:network-connector:vpc-egress",
  };
}

describe("MicrovmSandboxExecutor.resumeHarnessReservation", (): void => {
  test("a non-persistent sandbox cannot resume a session", async (): Promise<void> => {
    stores(null);

    await expect(
      executor({ persistent: false }).resumeHarnessReservation({
        reservationKey: "acct:agent:s16a",
      }),
    ).rejects.toThrow("persistent");
  });
});

describe("MicrovmSandboxExecutor.getInstanceInfo", (): void => {
  test("a request with no reservation key has no instance", async (): Promise<void> => {
    stores("microvm-1");

    expect(await executor().getInstanceInfo({})).toBeNull();
  });

  test("the VM state maps to the instance state", async (): Promise<void> => {
    stores("microvm-1");
    const request = { reservationKey: "acct:agent:s16b" };
    const states: Array<[string | undefined, string]> = [
      ["SUSPENDED", "suspended"],
      ["TERMINATING", "terminating"],
      [undefined, "unknown"],
    ];
    for (const [vm, expected] of states) {
      vmState = vm;
      const info = await executor().getInstanceInfo(request);
      expect(info?.state).toBe(expected);
    }
  });
});

describe("MicrovmSandboxExecutor.release", (): void => {
  test("a request with no key releases nothing", async (): Promise<void> => {
    stores("microvm-1");
    await executor().release({});

    expect(instanceStore.deleteSandboxInstance).not.toHaveBeenCalled();
  });

  test("a reservation with no VM releases nothing", async (): Promise<void> => {
    stores(null);
    await executor().release({ reservationKey: "acct:agent:s16c" });

    expect(instanceStore.deleteSandboxInstance).not.toHaveBeenCalled();
  });
});

describe("microvmShellConnection", (): void => {
  test("a response without the proxy token is an error", async (): Promise<void> => {
    shellToken = {};

    await expect(microvmShellConnection("microvm-1", client)).rejects.toThrow(
      "did not return an X-aws-proxy-auth token",
    );
  });
});

describe("boundedText", (): void => {
  const route = {
    path: "/guest/route",
    body: {},
    timeoutMs: 5000,
    reservationKey: "acct:agent:s16d",
  };

  test("a declared length over the cap is refused", async (): Promise<void> => {
    stores(null);
    routeResponse = (): Response =>
      new Response("{}", {
        headers: { "content-length": String(17 * 1024 * 1024) },
      });

    await expect(executor().postReserved(route)).rejects.toThrow(
      "answered more than 16777216 bytes",
    );
  });

  test("a body that grows past the cap is refused", async (): Promise<void> => {
    stores(null);
    routeResponse = (): Response =>
      new Response(
        new ReadableStream<Uint8Array>({
          start: function (controller): void {
            controller.enqueue(new Uint8Array(17 * 1024 * 1024));
            controller.close();
          },
        }),
      );

    await expect(
      executor().postReserved({ ...route, reservationKey: "acct:agent:s16e" }),
    ).rejects.toThrow("answered more than 16777216 bytes");
  });
});

describe("managedIngressConnectorArn", (): void => {
  test("a reserved VM needs a region for its ingress connectors", async (): Promise<void> => {
    stores(null);
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;

    await expect(
      executor().acquireHarnessReservation({
        reservationKey: "acct:agent:s16g",
      }),
    ).rejects.toThrow("MicroVM ingress connectors require AWS_REGION");
  });
});

describe("microvmImageScope", (): void => {
  test("a pinned snapshot that is not a MicroVM image ARN is refused", async (): Promise<void> => {
    stores(null);

    await expect(
      executor({ snapshot: "arn:aws:s3:::bucket" }).acquireHarnessReservation({
        reservationKey: "acct:agent:s16h",
      }),
    ).rejects.toThrow("config.snapshot must name a platform MicroVM image");
  });

  test("an image ARN with no name has no scope", async (): Promise<void> => {
    stores(null);
    process.env.MICROVM_IMAGE_IDENTIFIER =
      "arn:aws:lambda:us-east-1:123456789012:microvm-image";

    await expect(
      executor({ snapshot: IMAGE }).acquireHarnessReservation({
        reservationKey: "acct:agent:s16i",
      }),
    ).rejects.toThrow("config.snapshot must name a platform MicroVM image");
  });
});

describe("microvmImageVariant", (): void => {
  test("a variant of a malformed default image is refused", async (): Promise<void> => {
    stores(null);
    process.env.MICROVM_IMAGE_IDENTIFIER =
      "arn:aws:lambda:us-east-1:123456789012:function:other";

    await expect(
      executor({ image: "gpu" }).acquireHarnessReservation({
        reservationKey: "acct:agent:s16j",
      }),
    ).rejects.toThrow("config.image needs MICROVM_IMAGE_IDENTIFIER");
  });
});
