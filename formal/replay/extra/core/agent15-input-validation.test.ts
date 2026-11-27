import { afterEach, describe, expect, test } from "bun:test";

import { normalizeCreateAccountInput } from "../../../../apps/core/src/shared/domain/accounts.ts";
import { requireSecretsEnv } from "../../../../apps/core/src/shared/env.ts";
import { redact } from "../../../../apps/core/src/shared/log.ts";
import { workspaceSandboxLimits } from "../../../../apps/core/src/shared/sandbox.ts";

const TIMEOUT_ENV = "WORKSPACE_SANDBOX_DEFAULT_TIMEOUT_SECONDS";
const SECRETS_ENV = "AGENT15_SECRETS";

afterEach((): void => {
  delete process.env[TIMEOUT_ENV];
  delete process.env[SECRETS_ENV];
});

describe("normalizeCreateAccountInput", (): void => {
  test("trims the username and keeps a description", (): void => {
    expect(
      normalizeCreateAccountInput({
        username: " ada ",
        description: " notes ",
      }),
    ).toEqual({ username: "ada", description: "notes" });
  });

  test("drops an empty description", (): void => {
    expect(
      normalizeCreateAccountInput({ username: "ada", description: "  " }),
    ).toEqual({ username: "ada" });
  });

  test("refuses a body that is not an object", (): void => {
    expect((): unknown => normalizeCreateAccountInput("ada")).toThrow(
      "Request body must include username",
    );
  });

  test("refuses an agent config", (): void => {
    expect((): unknown =>
      normalizeCreateAccountInput({ username: "ada", config: {} }),
    ).toThrow("Agent config is created through /v1/agents");
  });

  test("refuses a blank username", (): void => {
    expect((): unknown =>
      normalizeCreateAccountInput({ username: " " }),
    ).toThrow("username must be a non-empty string");
  });

  test("refuses a description that is not a string", (): void => {
    expect((): unknown =>
      normalizeCreateAccountInput({ username: "ada", description: 3 }),
    ).toThrow("description must be a string");
  });
});

describe("workspaceSandboxLimits", (): void => {
  test("reads a positive integer from the environment", (): void => {
    process.env[TIMEOUT_ENV] = "45";

    expect(workspaceSandboxLimits().defaultTimeoutSeconds).toBe(45);
  });

  test.each(["0", "2.5", "soon"])("refuses %s", (value: string): void => {
    process.env[TIMEOUT_ENV] = value;

    expect((): unknown => workspaceSandboxLimits()).toThrow(
      `${TIMEOUT_ENV} must be a positive integer`,
    );
  });
});

describe("requireSecretsEnv", (): void => {
  test("refuses a list with no entries", (): void => {
    process.env[SECRETS_ENV] = " , ";

    expect((): unknown => requireSecretsEnv(SECRETS_ENV)).toThrow(
      `Missing required environment variable: ${SECRETS_ENV}`,
    );
  });
});

describe("redact", (): void => {
  test("scrubs strings inside arrays and leaves other scalars", (): void => {
    expect(
      redact(
        ["token-value-1234", 7, null, { note: "token-value-1234" }],
        ["token-value-1234"],
      ),
    ).toEqual([
      expect.not.stringContaining("token-value-1234"),
      7,
      null,
      {
        note: expect.not.stringContaining("token-value-1234"),
      },
    ]);
  });

  test("redacts a secret-named key whole", (): void => {
    expect(redact({ apiKey: "visible" }, [])).toEqual({ apiKey: "[redacted]" });
  });
});
