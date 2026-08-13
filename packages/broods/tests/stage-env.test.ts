import { afterEach, expect, test } from "bun:test";
import { stageFromEnv } from "../src/config.ts";

const original = {
  stage: process.env.BROODS_STAGE,
  legacy: process.env.BROODS_ENVIRONMENT,
};

afterEach(() => {
  restore("BROODS_STAGE", original.stage);
  restore("BROODS_ENVIRONMENT", original.legacy);
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

test("reads BROODS_STAGE", () => {
  process.env.BROODS_STAGE = "staging";

  expect(stageFromEnv()).toBe("staging");
});

// Hard rename: a project still carrying the old name must fail loudly rather
// than quietly resolving to a stage the user did not name.
test("ignores the pre-rename BROODS_ENVIRONMENT", () => {
  delete process.env.BROODS_STAGE;
  process.env.BROODS_ENVIRONMENT = "development";

  expect(stageFromEnv()).toBeUndefined();
});

test("is undefined when BROODS_STAGE is unset", () => {
  delete process.env.BROODS_STAGE;
  delete process.env.BROODS_ENVIRONMENT;

  expect(stageFromEnv()).toBeUndefined();
});
