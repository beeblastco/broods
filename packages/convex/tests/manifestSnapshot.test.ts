import { describe, expect, test } from "vitest";
import { manifestHash } from "../model/manifestSnapshot";
import { isStageSourcePath, stageSourceProblem } from "../model/stageSource";

describe("manifestHash", () => {
  test("ignores resource order, key order and artifact bytes, not their sha256", async () => {
    const mcp = (bundle: string, sha256: string) => ({
      kind: "mcp",
      name: "dock",
      config: { sha256: sha256, bundle: bundle, transport: "hosted" },
    });
    const agent = { kind: "agent", name: "a", config: { b: 1, a: 2 } };
    const reordered = { kind: "agent", name: "a", config: { a: 2, b: 1 } };

    const base = await manifestHash([agent, mcp("x", "s1")]);

    expect(await manifestHash([mcp("y", "s1"), reordered])).toBe(base);
    expect(await manifestHash([agent, mcp("x", "s2")])).not.toBe(base);
  });

  test("reads an env ref the way the stage stores it", async () => {
    const ref = { __beeblastEnv: true, name: "KEY" };

    expect(
      await manifestHash([{ kind: "agent", name: "a", config: { key: ref } }]),
    ).toBe(
      await manifestHash([
        { kind: "agent", name: "a", config: { key: "${KEY}" } },
      ]),
    );
  });
});

describe("stage source", () => {
  test("holds broods/ text and the root manifests, never dot or build files", () => {
    expect(isStageSourcePath("broods/index.ts")).toBe(true);
    expect(isStageSourcePath("bun.lock")).toBe(true);
    expect(isStageSourcePath("broods/.env")).toBe(false);
    expect(isStageSourcePath("broods/_generated/ids.ts")).toBe(false);
    expect(isStageSourcePath("broods/../secrets.ts")).toBe(false);
    expect(isStageSourcePath(".env.local")).toBe(false);
    expect(
      stageSourceProblem([
        { path: "broods/a.ts", content: "" },
        { path: "broods/a.ts", content: "" },
      ]),
    ).toBe("broods/a.ts is listed twice");
  });
});
