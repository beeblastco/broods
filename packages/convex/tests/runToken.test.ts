/// <reference types="vite/client" />
/**
 * A run token (`brt_`) is a core credential for one agent run: the config
 * plane and the CLI routes refuse it on the prefix alone.
 */

import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

test("refuses a run token on the config plane and the CLI routes", async () => {
  const t = convexTest(schema, modules);
  for (const path of [
    "/v1/audit",
    "/v1/agents",
    "/v1/account/projects/demo/stages/development/manifest",
  ]) {
    const response = await t.fetch(path, {
      headers: { Authorization: "Bearer brt_abc.def" },
    });
    expect(response.status, path).toBe(401);
    expect(await response.json(), path).toMatchObject({
      error: { message: "run tokens cannot reach the config plane" },
    });
  }
});
