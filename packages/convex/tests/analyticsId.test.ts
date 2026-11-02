/// <reference types="vite/client" />
// The PostHog id counts a person once across devices without telling PostHog who they are.
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { sha256Hex } from "../model/accountSecrets";
import schema from "../schema";

vi.mock("../auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth")>()),
  authKit: { getAuthUser: async () => ({ id: "auth_user" }) },
}));

const modules = import.meta.glob("../**/*.ts");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("user.analyticsId", () => {
  test("is stable for a user and needs the secret to reproduce", async () => {
    vi.stubEnv("ANALYTICS_ID_SECRET", "analytics-secret");
    const t = convexTest(schema, modules);
    const id = await t.query(api.user.analyticsId, {});

    expect(await t.query(api.user.analyticsId, {})).toBe(id);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id).not.toBe(await sha256Hex("auth_user"));
    vi.stubEnv("ANALYTICS_ID_SECRET", "another-secret");
    expect(await t.query(api.user.analyticsId, {})).not.toBe(id);
  });

  test("is null without the secret, so tracking stays anonymous", async () => {
    vi.stubEnv("ANALYTICS_ID_SECRET", "");
    const t = convexTest(schema, modules);

    expect(await t.query(api.user.analyticsId, {})).toBeNull();
  });
});
