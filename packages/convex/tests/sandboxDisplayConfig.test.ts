/// <reference types="vite/client" />
/** The canvas projection of a sandbox config: display keys in, secrets out. */

import { describe, expect, test } from "vitest";
import { sandboxDisplayConfig } from "../model/sandboxDisplayConfig";

describe("sandboxDisplayConfig", () => {
  test("keeps the fields the canvas renders", () => {
    const display = sandboxDisplayConfig({
      network: { mode: "allow-all" },
      permissionMode: "bypass",
      persistent: true,
      provider: "sandbox",
    });

    expect(display).toEqual({
      network: { mode: "allow-all" },
      permissionMode: "bypass",
      persistent: true,
      provider: "sandbox",
    });
  });

  test("drops credentials and everything else", () => {
    const display = sandboxDisplayConfig({
      network: { mode: "allow-all" },
      envVars: { GH_TOKEN: "ghp_secret" },
      options: { apiKey: "sk-secret" },
      onCreate: ["gh auth setup-git"],
      snapshot: "snap-1",
      timeout: 60,
    });

    expect(display).toEqual({ network: { mode: "allow-all" } });
    expect(display.envVars).toBeUndefined();
    expect(display.options).toBeUndefined();
  });

  test("absent and non-object configs collapse to an empty projection", () => {
    expect(sandboxDisplayConfig({})).toEqual({});
    expect(sandboxDisplayConfig(undefined)).toEqual({});
    expect(sandboxDisplayConfig("allow-all")).toEqual({});
    expect(sandboxDisplayConfig([{ network: { mode: "allow-all" } }])).toEqual(
      {},
    );
  });
});
