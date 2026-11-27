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
  CreateMicrovmImageCommand,
  CreateMicrovmShellAuthTokenCommand,
  GetMicrovmCommand,
  GetMicrovmImageCommand,
  GetMicrovmImageVersionCommand,
  TerminateMicrovmCommand,
} from "../../../../apps/core/node_modules/@aws-sdk/client-lambda-microvms";
import * as instanceStore from "../../../../apps/core/src/harness/sandbox/instance-store.ts";
import {
  MicrovmSandboxExecutor,
  microvmShellConnection,
} from "../../../../apps/core/src/harness/sandbox/microvm-executor.ts";
import type { SandboxExecutorConfig } from "../../../../apps/core/src/harness/sandbox/types.ts";
import * as s3 from "../../../../apps/core/src/shared/s3.ts";

const IMAGE = "arn:aws:lambda:us-east-1:123456789012:microvm-image:sandbox";
const ENDPOINT = "microvm-9.lambda-microvm.us-east-1.on.aws";
const envBefore = { ...process.env };
const fetchBefore = globalThis.fetch;

let getOutcome: Record<string, unknown> | Error = {
  imageArn: IMAGE,
  imageVersion: "1.0",
  startedAt: new Date(1_791_360_000_000),
  endpoint: ENDPOINT,
  state: "RUNNING",
};
let terminateOutcome: Error | undefined;
let imageState: Record<string, unknown> = {};
let createImageOutcome: Record<string, unknown> | Error = {
  imageArn:
    "arn:aws:lambda:us-east-1:123456789012:microvm-image:broods-snapshot-x",
};
let artifactUri: string | undefined =
  "s3://artifacts/microvm-images/source.zip";
let captureExit = 0;

const client = {
  send: async (command: object): Promise<Record<string, unknown>> => {
    if (command instanceof GetMicrovmCommand) {
      if (getOutcome instanceof Error) throw getOutcome;

      return getOutcome;
    }
    if (command instanceof TerminateMicrovmCommand) {
      if (terminateOutcome) throw terminateOutcome;

      return {};
    }
    if (command instanceof GetMicrovmImageCommand) return imageState;
    if (command instanceof GetMicrovmImageVersionCommand) {
      return {
        codeArtifact: artifactUri ? { uri: artifactUri } : undefined,
        baseImageArn: "arn:aws:lambda:us-east-1:aws:microvm-image:base",
        baseImageVersion: "1.0",
        buildRoleArn: "arn:aws:iam::123456789012:role/build",
      };
    }
    if (command instanceof CreateMicrovmImageCommand) {
      if (createImageOutcome instanceof Error) throw createImageOutcome;

      return createImageOutcome;
    }
    if (command instanceof CreateMicrovmAuthTokenCommand) {
      return { authToken: { "X-aws-proxy-auth": "proxy-token" } };
    }
    if (command instanceof CreateMicrovmShellAuthTokenCommand) {
      return { authToken: { "X-aws-proxy-auth": "shell-token" } };
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

beforeAll((): void => {
  process.env.AWS_REGION = "us-east-1";
  process.env.MICROVM_IMAGE_IDENTIFIER = IMAGE;
  process.env.FILESYSTEM_BUCKET_NAME = "staging-bucket";
  globalThis.fetch = Object.assign(
    async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          ok: captureExit === 0,
          runtime: "bash",
          exit_code: captureExit,
          timed_out: false,
          duration_ms: 5,
          stdout: "",
          stderr: "capture failed",
          truncated: false,
        }),
        { status: 200 },
      ),
    { preconnect: fetchBefore.preconnect },
  );
});

afterAll((): void => {
  process.env = envBefore;
  globalThis.fetch = fetchBefore;
});

afterEach((): void => {
  getOutcome = {
    imageArn: IMAGE,
    imageVersion: "1.0",
    startedAt: new Date(1_791_360_000_000),
    endpoint: ENDPOINT,
    state: "RUNNING",
  };
  terminateOutcome = undefined;
  imageState = {};
  artifactUri = "s3://artifacts/microvm-images/source.zip";
  captureExit = 0;
  createImageOutcome = {
    imageArn:
      "arn:aws:lambda:us-east-1:123456789012:microvm-image:broods-snapshot-x",
  };
});

function reserved(id: string | null): void {
  spyOn(instanceStore, "getSandboxExternalId").mockResolvedValue(id);
  spyOn(instanceStore, "deleteSandboxInstance").mockResolvedValue(true);
}

describe("MicroVM reservation lifecycle", () => {
  test("release terminates the VM and drops its row", async (): Promise<void> => {
    reserved("microvm-9");
    await executor().release({ reservationKey: "rk-14k" });
    expect(instanceStore.deleteSandboxInstance).toHaveBeenCalled();
  });

  test("release treats a VM that is already gone as released", async (): Promise<void> => {
    reserved("microvm-9");
    terminateOutcome = Object.assign(new Error("not found"), {
      name: "ResourceNotFoundException",
    });
    await executor().release({ reservationKey: "rk-14l" });
  });

  test("release raises when the VM cannot be terminated", async (): Promise<void> => {
    reserved("microvm-9");
    terminateOutcome = new Error("Rate exceeded");
    await expect(
      executor().release({ reservationKey: "rk-14m" }),
    ).rejects.toThrow("failed to terminate");
  });

  test("instance info maps the state, and reports a lookup failure as unknown", async (): Promise<void> => {
    reserved("microvm-9");
    expect(
      await executor().getInstanceInfo({ reservationKey: "rk-14n" }),
    ).toEqual({
      externalId: "microvm-9",
      state: "running",
    });
    getOutcome = new Error("boom");
    expect(
      await executor().getInstanceInfo({ reservationKey: "rk-14n" }),
    ).toEqual({
      externalId: "microvm-9",
      state: "unknown",
      errorMessage: "boom",
    });
    getOutcome = new Error("microvm does not exist");
    expect(
      await executor().getInstanceInfo({ reservationKey: "rk-14n" }),
    ).toBeNull();
  });

  test("snapshot status follows the image's versions", async (): Promise<void> => {
    imageState = { latestActiveImageVersion: "1" };
    expect(await executor().snapshotStatus("arn:image")).toBe("active");
    imageState = { state: "CREATE_FAILED" };
    expect(await executor().snapshotStatus("arn:image")).toBe("build_failed");
    imageState = {};
    expect(await executor().snapshotStatus("arn:image")).toBe("building");
  });

  test("a shell connection needs the VM's endpoint, and an auth token is cached per port", async (): Promise<void> => {
    expect(await microvmShellConnection("microvm-9", client)).toEqual({
      url: `wss://${ENDPOINT}`,
      authorization: "shell-token",
    });
    getOutcome = { state: "RUNNING" };
    await expect(microvmShellConnection("microvm-9", client)).rejects.toThrow(
      "no endpoint",
    );
    expect(await executor().createHarnessAuthToken("microvm-9", 4321)).toBe(
      "proxy-token",
    );
    await expect(
      executor().createHarnessAuthToken("microvm-9", 0),
    ).rejects.toThrow("port is invalid");
  });
});

describe("MicroVM snapshot", () => {
  function stage(): void {
    spyOn(s3, "copyS3Object").mockResolvedValue(undefined as never);
    spyOn(s3, "getS3ObjectUrl").mockResolvedValue("https://s3.test/source.zip");
    spyOn(s3, "putS3ObjectUrl").mockResolvedValue("https://s3.test/image.zip");
    spyOn(s3, "deleteS3Object").mockResolvedValue(undefined as never);
  }

  test("a snapshot copies the source image, captures changes and builds a new image", async (): Promise<void> => {
    reserved("microvm-9");
    stage();
    const result = await executor().snapshot({ reservationKey: "rk-14o" });
    expect(result.status).toBe("building");
    expect(result.externalImageId).toContain("broods-snapshot-x");
  });

  test("a failed capture raises and clears the staged files", async (): Promise<void> => {
    reserved("microvm-9");
    stage();
    captureExit = 1;
    await expect(
      executor().snapshot({ reservationKey: "rk-14p" }),
    ).rejects.toThrow("snapshot capture failed");
    expect(s3.deleteS3Object).toHaveBeenCalled();
  });

  test("a rejected image build removes the uploaded artifact", async (): Promise<void> => {
    reserved("microvm-9");
    stage();
    createImageOutcome = new Error("quota");
    await expect(
      executor().snapshot({ reservationKey: "rk-14q" }),
    ).rejects.toThrow("quota");
  });

  test("a VM whose image has no S3 artifact cannot be snapshotted", async (): Promise<void> => {
    reserved("microvm-9");
    stage();
    artifactUri = undefined;
    await expect(
      executor().snapshot({ reservationKey: "rk-14r" }),
    ).rejects.toThrow("no S3 code artifact");
  });

  test("a sandbox with no VM has nothing to snapshot", async (): Promise<void> => {
    reserved(null);
    await expect(
      executor().snapshot({ reservationKey: "rk-14s" }),
    ).rejects.toThrow("no reserved MicroVM");
  });
});
