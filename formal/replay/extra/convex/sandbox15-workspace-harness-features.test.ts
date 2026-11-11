import { describe, expect, test } from "bun:test";

import { normalizeWorkspaceConfig } from "../../../../packages/convex/model/workspaceRules";

describe("normalizeWorkspaceConfig harness features", (): void => {
  test("keeps only the features that are switched off", (): void => {
    const config = normalizeWorkspaceConfig({
      harness: { workspace: { enabled: false }, memory: { enabled: true } },
    });
    expect(config.harness).toEqual({ workspace: { enabled: false } });
  });

  test("switching both off keeps both", (): void => {
    const config = normalizeWorkspaceConfig({
      harness: { workspace: { enabled: false }, memory: { enabled: false } },
    });
    expect(config.harness).toEqual({
      workspace: { enabled: false },
      memory: { enabled: false },
    });
  });

  test("leaving both on drops the harness block", (): void => {
    const config = normalizeWorkspaceConfig({
      harness: { workspace: { enabled: true }, memory: {} },
    });
    expect(config.harness).toBeUndefined();
  });
});
