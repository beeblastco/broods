import { afterEach, expect, test } from "bun:test";
import { keyHint } from "../../../../packages/convex/model/accountSecrets.ts";
import {
  createRoleId,
  createRoleSessionToken,
  normalizeAssumeRoleInput,
  normalizeCreateRoleInput,
  normalizeUpdateRoleInput,
} from "../../../../packages/convex/model/roleRules.ts";
import {
  serviceEnv,
  serviceHeaders,
} from "../../../../packages/convex/model/serviceBridge.ts";

const POLICY = {
  version: 1,
  rules: [],
};

const SAVED_URL = process.env.BROODS_ACCOUNT_MANAGE_URL;
const SAVED_SECRET = process.env.SERVICE_AUTH_SECRET;

afterEach((): void => {
  process.env.BROODS_ACCOUNT_MANAGE_URL = SAVED_URL;
  process.env.SERVICE_AUTH_SECRET = SAVED_SECRET;
});

test("role ids and session tokens carry their prefixes", (): void => {
  expect(createRoleId().startsWith("brole_")).toBe(true);
  expect(createRoleSessionToken().startsWith("bsts_")).toBe(true);
});

test("keyHint keeps only the last four characters", (): void => {
  expect(keyHint("bsk_", "abcdefgh")).toBe("bsk_…efgh");
  expect(keyHint("bsk_", "ab")).toBe("bsk_…ab");
});

test("assume role trims the id and defaults the ttl", (): void => {
  expect(normalizeAssumeRoleInput({ roleId: " brole_1 " })).toEqual({
    roleId: "brole_1",
    ttlSeconds: 3600,
  });
  expect(
    normalizeAssumeRoleInput({ roleId: "brole_1", ttlSeconds: 60 }).ttlSeconds,
  ).toBe(60);
});

test.each([
  [{ roleId: "brole_1", ttlSeconds: 0 }],
  [{ ttlSeconds: 60 }],
  ["x"],
])("assume role refuses %j", (input: unknown): void => {
  expect((): unknown => normalizeAssumeRoleInput(input)).toThrow();
});

test("create role drops blank scope ids and keeps real ones", (): void => {
  const blank = normalizeCreateRoleInput({
    name: " ops ",
    policy: POLICY,
    projectId: "  ",
    stageId: "",
  });
  expect(blank.name).toBe("ops");
  expect("projectId" in blank).toBe(false);
  expect("stageId" in blank).toBe(false);

  const scoped = normalizeCreateRoleInput({
    name: "ops",
    policy: POLICY,
    projectId: " p1 ",
    stageId: " s1 ",
  });
  expect(scoped.projectId).toBe("p1");
  expect(scoped.stageId).toBe("s1");
});

test("create role refuses a missing name", (): void => {
  expect((): unknown => normalizeCreateRoleInput({ policy: POLICY })).toThrow();
});

test("update role patches only what was sent", (): void => {
  expect(normalizeUpdateRoleInput({ name: " new " })).toEqual({ name: "new" });
  expect(normalizeUpdateRoleInput({ status: "disabled" })).toEqual({
    status: "disabled",
  });
  expect(Object.keys(normalizeUpdateRoleInput({ policy: POLICY }))).toEqual([
    "policy",
  ]);
});

test("update role refuses an empty patch", (): void => {
  expect((): unknown => normalizeUpdateRoleInput({})).toThrow(
    "Request body must include name, policy, or status",
  );
});

test("serviceEnv strips trailing slashes and needs both values", (): void => {
  process.env.BROODS_ACCOUNT_MANAGE_URL = "https://core.example//";
  process.env.SERVICE_AUTH_SECRET = "s3";
  expect(serviceEnv()).toEqual({ url: "https://core.example", secret: "s3" });

  delete process.env.SERVICE_AUTH_SECRET;
  expect((): unknown => serviceEnv()).toThrow("missing");

  process.env.SERVICE_AUTH_SECRET = "s3";
  delete process.env.BROODS_ACCOUNT_MANAGE_URL;
  expect((): unknown => serviceEnv()).toThrow("missing");
});

test("serviceHeaders names the account and the bearer", (): void => {
  expect(serviceHeaders("acct_1", "s3")).toEqual({
    Authorization: "Bearer s3",
    "X-Account-Id": "acct_1",
    "Content-Type": "application/json",
  });
});
