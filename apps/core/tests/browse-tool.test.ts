import { describe, expect, it } from "bun:test";
import { compatibilityApprovalStatus } from "../src/harness/policy.ts";
import type { SandboxExecutorConfig } from "../src/harness/sandbox/types.ts";
import {
  assertBrowseSandbox,
  obscuraCommand,
} from "../src/harness/tools/browse.tool.ts";

const OBSCURA_SANDBOX: SandboxExecutorConfig = {
  provider: "lambda",
  image: "obscura",
  network: { mode: "allow-all" },
  timeout: 60,
};

describe("browse tool", () => {
  it("accepts only a first sandbox that can run Obscura", () => {
    expect(() => assertBrowseSandbox(OBSCURA_SANDBOX)).not.toThrow();
    expect(() => assertBrowseSandbox({ provider: "machine" })).not.toThrow();
    expect(() =>
      assertBrowseSandbox({
        provider: "lambda",
        network: { mode: "allow-all" },
      }),
    ).toThrow('image: "obscura"');
    expect(() =>
      assertBrowseSandbox({
        ...OBSCURA_SANDBOX,
        network: { mode: "deny-all" },
      }),
    ).toThrow("network.mode to allow-all");
    expect(() => assertBrowseSandbox(undefined)).toThrow('image: "obscura"');
  });

  it("asks before eval runs the model's JavaScript, unless the sandbox bypasses", () => {
    const approval = (
      mode: string,
      permissionMode: "ask" | "bypass",
    ): ReturnType<typeof compatibilityApprovalStatus> =>
      compatibilityApprovalStatus(
        "browse",
        { url: "https://example.com", mode: mode },
        {
          configuredApprovals: new Map(),
          workspaces: [],
          sandboxes: [
            {
              name: "web",
              sandbox: { ...OBSCURA_SANDBOX, permissionMode: permissionMode },
            },
          ],
        },
      );

    expect(approval("eval", "ask")).toBe("user-approval");
    expect(approval("eval", "bypass")).toBeUndefined();
    expect(approval("markdown", "ask")).toBeUndefined();
    expect(approval("screenshot", "ask")).toBeUndefined();
  });

  it("builds one quoted obscura command per mode, inside the exec timeout", () => {
    const call = {
      url: "https://example.com/a b",
      path: ".broods/browse/x.png",
    };

    expect(obscuraCommand(OBSCURA_SANDBOX, { ...call, mode: "markdown" })).toBe(
      "obscura fetch 'https://example.com/a b' --quiet --timeout 55 --dump markdown",
    );
    expect(
      obscuraCommand(OBSCURA_SANDBOX, {
        ...call,
        mode: "eval",
        script: "document.title",
      }),
    ).toBe(
      "obscura fetch 'https://example.com/a b' --quiet --timeout 55 --eval 'document.title'",
    );
    expect(
      obscuraCommand({ provider: "machine" }, { ...call, mode: "screenshot" }),
    ).toBe(
      "mkdir -p .broods/browse && obscura fetch 'https://example.com/a b' --quiet --timeout 25 --screenshot '.broods/browse/x.png'",
    );
  });
});
