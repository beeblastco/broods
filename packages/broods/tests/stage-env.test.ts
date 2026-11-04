import { afterEach, expect, test } from "bun:test";
import { stageFromEnv } from "../src/config.ts";

const original = {
  stage: process.env.BROODS_STAGE,
  legacy: process.env.BROODS_ENVIRONMENT,
};

afterEach((): void => {
  restore("BROODS_STAGE", original.stage);
  restore("BROODS_ENVIRONMENT", original.legacy);
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

test("reads BROODS_STAGE", (): void => {
  process.env.BROODS_STAGE = "staging";

  expect(stageFromEnv()).toBe("staging");
});

test("ignores the pre-rename BROODS_ENVIRONMENT", (): void => {
  delete process.env.BROODS_STAGE;
  process.env.BROODS_ENVIRONMENT = "development";

  expect(stageFromEnv()).toBeUndefined();
});
