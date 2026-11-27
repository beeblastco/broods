import { afterEach, describe, expect, test } from "bun:test";

import {
  normalizeSandboxConfig,
  workspaceSandboxLimits,
} from "../../../../packages/convex/model/sandboxRules";

const LIMIT_ENV = "WORKSPACE_SANDBOX_MAX_OUTPUT_LIMIT_BYTES";
const saved = process.env[LIMIT_ENV];

afterEach((): void => {
  if (saved === undefined) delete process.env[LIMIT_ENV];
  else process.env[LIMIT_ENV] = saved;
});

describe("positiveIntegerEnv", (): void => {
  test("a limit override that is not a positive integer is refused", (): void => {
    process.env[LIMIT_ENV] = "abc";

    expect((): unknown => workspaceSandboxLimits("lambda")).toThrow(
      `${LIMIT_ENV} must be a positive integer`,
    );
  });

  test("a valid override replaces the default", (): void => {
    process.env[LIMIT_ENV] = "4096";

    expect(workspaceSandboxLimits("lambda").maxOutputLimitBytes).toBe(4096);
  });
});

describe("assertWorkerLifecycle", (): void => {
  test("a worker sandbox takes no lifecycle", (): void => {
    expect((): unknown =>
      normalizeSandboxConfig({
        provider: "worker",
        persistent: true,
        lifecycle: { idleTimeoutSeconds: 60 },
      }),
    ).toThrow("config.lifecycle is not supported by the worker provider");
  });
});

describe("validateProviderOptions", (): void => {
  test("an s3Endpoint must be a public HTTPS URL", (): void => {
    expect((): unknown =>
      normalizeSandboxConfig({
        provider: "daytona",
        options: { s3Endpoint: "http://insecure.example.com" },
      }),
    ).toThrow("config.options.s3Endpoint");
  });

  test("a public s3Endpoint is kept", (): void => {
    expect(
      normalizeSandboxConfig({
        provider: "daytona",
        options: { s3Endpoint: "https://s3.example.com" },
      }).options,
    ).toEqual({ s3Endpoint: "https://s3.example.com" });
  });
});
