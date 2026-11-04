/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { openUserToken } from "../model/userToken";
import schema from "../schema";

const AUTH_ID = "user_01DOCKTEST";
const SIGNING_SECRET = "bsig_dock-test";

// The mutation reads its caller through the WorkOS component, absent from the test runtime.
vi.mock("../auth", () => ({
  authKit: { getAuthUser: async () => ({ id: AUTH_ID }) },
}));

const modules = import.meta.glob("../**/*.ts");

const dockTest = (): TestConvex<typeof schema> => convexTest(schema, modules);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("agentDock.session", () => {
  test("is null on a deployment with no Broods agent configured", async () => {
    expect(await dockTest().mutation(api.agentDock.session, {})).toBeNull();
  });

  test("hands the dock the agent and a user token for the signed-in user", async () => {
    vi.stubEnv(
      "BROODS_AGENT_URL",
      "https://gateway.example.com/v1/projects/broods/stages/production/agents/ep_1",
    );
    vi.stubEnv("BROODS_AGENT_ID", "agent_1");
    vi.stubEnv("BROODS_AGENT_RUNTIME_KEY", "bsk_runtime");
    vi.stubEnv("BROODS_AGENT_USER_TOKEN_SECRET", SIGNING_SECRET);

    const session = await dockTest().mutation(api.agentDock.session, {});

    expect(session).toMatchObject({
      agentId: "agent_1",
      runtimeKey: "bsk_runtime",
      url: "https://gateway.example.com/v1/projects/broods/stages/production/agents/ep_1",
    });
    const opened = await openUserToken(
      session?.userToken ?? "",
      SIGNING_SECRET,
    );
    expect(opened).toMatchObject({ userId: AUTH_ID });
    expect(opened?.conversations).toBeUndefined();
  });
});
