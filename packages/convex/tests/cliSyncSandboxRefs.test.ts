/** Extra agent sandboxes travel by name in a manifest and by id at rest. */

import { describe, expect, test } from "vitest";
import { rewriteIdsToNames, rewriteResourceRefs } from "../model/cliSync";

const SANDBOX_IDS = {
  "general-sandbox": "sb_general",
  "offline-sandbox": "sb_offline",
};

describe("cli sync sandbox refs", () => {
  test("rewrites extra sandbox names to ids and back", () => {
    const stored = rewriteResourceRefs(
      { sandbox: "general-sandbox", sandboxes: ["offline-sandbox"] },
      { workspaces: {}, sandboxes: SANDBOX_IDS, policies: {} },
    );

    expect(stored).toEqual({
      sandbox: "sb_general",
      sandboxes: ["sb_offline"],
    });
    expect(
      rewriteIdsToNames(stored, {
        workspaces: {},
        sandboxes: {
          sb_general: "general-sandbox",
          sb_offline: "offline-sandbox",
        },
      }),
    ).toEqual({
      sandbox: "general-sandbox",
      sandboxes: ["offline-sandbox"],
    });
  });
});
