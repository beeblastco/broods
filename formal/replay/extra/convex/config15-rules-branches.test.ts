import { describe, expect, test } from "bun:test";

import { normalizeAgentConfig } from "../../../../packages/convex/model/agentRules";
import {
  ClientError,
  clientErrorData,
} from "../../../../packages/convex/model/clientError";
import {
  mergeConfigObjects,
  REDACTED_SECRET_VALUE,
} from "../../../../packages/convex/model/configValues";
import { parseInput } from "../../../../packages/convex/model/inputSchema";
import { normalizeMcpInput } from "../../../../packages/convex/model/mcp";
import { stableJson } from "../../../../packages/convex/model/objects";
import { z } from "../../../../packages/convex/node_modules/zod/mini";

function messageOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : "";
  }

  return "";
}

function withData(data: unknown): ClientError {
  return Object.assign(new ClientError("x"), { data: data });
}

describe("normalizeAgentConfig harness", (): void => {
  test("refuses policies next to a harness", (): void => {
    expect(
      messageOf((): unknown =>
        normalizeAgentConfig(
          { harness: { type: "codex" }, policies: ["p1"] },
          { patch: true },
        ),
      ),
    ).toContain("config.policies is not supported with config.harness");
  });

  test("accepts a plain harness", (): void => {
    expect(
      normalizeAgentConfig({ harness: { type: "codex" } }, { patch: true }),
    ).toEqual({ harness: { type: "codex" } });
  });
});

describe("mergeConfigObjects", (): void => {
  test("keeps the existing value for undefined and redacted patches", (): void => {
    expect(
      mergeConfigObjects(
        { a: 1, b: "secret" },
        { a: undefined, b: REDACTED_SECRET_VALUE },
      ),
    ).toEqual({ a: 1, b: "secret" });
  });

  test("a null patch removes the key", (): void => {
    expect(mergeConfigObjects({ a: 1, b: 2 }, { a: null })).toEqual({ b: 2 });
  });

  test("skips prototype keys in the patch", (): void => {
    const patch = JSON.parse('{"__proto__":{"x":1},"y":2}') as object;
    const merged = mergeConfigObjects({}, patch);

    expect(merged).toEqual({ y: 2 });
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
  });
});

describe("clientErrorData", (): void => {
  test("returns null for anything but a client error", (): void => {
    expect(clientErrorData(new Error("x"))).toBeNull();
    expect(clientErrorData(withData("text"))).toBeNull();
    expect(clientErrorData(withData({ code: "invalid_request" }))).toBeNull();
    expect(
      clientErrorData(withData({ code: "nope", message: "m" })),
    ).toBeNull();
    expect(
      clientErrorData(withData({ code: "invalid_request", message: 1 })),
    ).toBeNull();
  });

  test("returns the code and message of a client error", (): void => {
    expect(clientErrorData(new ClientError("bad"))).toEqual({
      code: "invalid_request",
      message: "bad",
    });
  });
});

describe("stableJson", (): void => {
  test("sorts keys inside arrays of objects", (): void => {
    expect(stableJson([{ b: 1, a: 2 }, 3])).toBe('[{"a":2,"b":1},3]');
  });
});

describe("parseInput messages", (): void => {
  test("names an integer where a float was given", (): void => {
    expect(
      messageOf((): unknown => parseInput(z.int(), 1.5, "config.count")),
    ).toContain("must be an integer");
  });
});

describe("normalizeMcpInput limits", (): void => {
  const options = { requireConnection: false };

  async function failure(body: unknown): Promise<string> {
    try {
      await normalizeMcpInput(body, options);
    } catch (error) {
      return error instanceof Error ? error.message : "";
    }

    return "";
  }

  test("refuses headers that are not an object", async (): Promise<void> => {
    expect(await failure({ headers: ["a"] })).toContain(
      "headers must be an object",
    );
  });

  test("refuses too many headers", async (): Promise<void> => {
    const headers = Object.fromEntries(
      Array.from({ length: 17 }, (_, i): [string, string] => [`h${i}`, "v"]),
    );

    expect(await failure({ headers: headers })).toContain(
      "headers must contain at most 16 entries",
    );
  });

  test("refuses a header name that is not a token", async (): Promise<void> => {
    expect(await failure({ headers: { "bad name": "v" } })).toContain(
      "RFC 9110 tokens: bad name",
    );
  });
});
