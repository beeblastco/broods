import { describe, expect, it } from "bun:test";

import { handler as nodeSandboxHandler } from "../functions/sandbox-node/handler.ts";

describe("sandbox runtime lambdas", () => {
  it("executes JavaScript with the current runtime binary", async () => {
    const result = await nodeSandboxHandler({
      runtime: "node",
      entry: {
        path: "/main.js",
        content: "console.log(JSON.stringify({ language: 'javascript', answer: 21 * 2 }));",
      },
      args: [],
      timeoutSeconds: 5,
      outputLimitBytes: 4096,
    });

    expect(result).toMatchObject({
      ok: true,
      runtime: "node",
      exitCode: 0,
      stdout: "{\"language\":\"javascript\",\"answer\":42}\n",
      stderr: "",
      timedOut: false,
      truncated: false,
    });
  });
});
