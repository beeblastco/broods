import { describe, expect, test } from "bun:test";

import {
  accountHookBundleStorageKey,
  normalizeAccountHookUpload,
} from "../../../../packages/convex/model/accountHooks";
import {
  findHarnessEntry,
  takeHarnessEntryBatch,
} from "../../../../packages/convex/model/harnessSessionEntries";
import {
  accountOrg,
  budgetLevel,
  isManagedService,
} from "../../../../packages/convex/model/planLimits";
import { normalizeUpdatePolicyInput } from "../../../../packages/convex/model/policyRules";
import { parseHandbackDedupeKey } from "../../../../packages/convex/model/subagentResults";

type Upload = Record<string, unknown>;

const BUNDLE = "export default async function hook() { return {}; }";

async function* rows(
  entries: string[],
): AsyncGenerator<{ entry: string }, void, undefined> {
  for (const entry of entries) yield { entry: entry };
}

describe("parseHandbackDedupeKey", () => {
  test.each([
    [
      "subagent:evt:1:completed",
      { kind: "subagent", eventId: "evt:1", status: "completed" },
    ],
    [
      "subagent:evt:failed",
      { kind: "subagent", eventId: "evt", status: "failed" },
    ],
    [
      "async-tool:res:awaiting_input",
      { kind: "async-tool", resultId: "res", status: "awaiting_input" },
    ],
    ["subagent::completed", undefined],
    ["subagent:evt:running", undefined],
    ["other:evt:completed", undefined],
    ["", undefined],
  ])("%s", (key: string, expected: unknown): void => {
    expect(parseHandbackDedupeKey(key)).toEqual(expected as never);
  });
});

describe("budget and plan helpers", () => {
  test.each([
    [0, "ok"],
    [79.99, "ok"],
    [80, "warning"],
    [99.5, "warning"],
    [100, "exhausted"],
    [140, "exhausted"],
  ])("budgetLevel(%d)", (percent: number, level: string): void => {
    expect(budgetLevel(percent)).toBe(level as never);
  });

  test.each([
    ["true", true],
    ["false", false],
    [undefined, false],
  ])(
    "isManagedService with %s",
    (value: string | undefined, expected: boolean): void => {
      const before = process.env.BROODS_MANAGED_SERVICE;
      if (value === undefined) delete process.env.BROODS_MANAGED_SERVICE;
      else process.env.BROODS_MANAGED_SERVICE = value;
      try {
        expect(isManagedService()).toBe(expected);
      } finally {
        if (before === undefined) delete process.env.BROODS_MANAGED_SERVICE;
        else process.env.BROODS_MANAGED_SERVICE = before;
      }
    },
  );

  test.each([
    [null, null, null],
    [{ orgId: "bad" }, null, null],
    [{ orgId: "org1" }, "org1", { _id: "org1" }],
  ])(
    "accountOrg %#",
    async (
      account: unknown,
      normalized: string | null,
      expected: unknown,
    ): Promise<void> => {
      const ctx = {
        db: {
          get: async (id: string): Promise<unknown> =>
            id === "acct" ? account : { _id: id },
          normalizeId: (_table: string, _id: string): string | null =>
            normalized,
        },
      };

      expect(await accountOrg(ctx as never, "acct" as never)).toEqual(
        expected as never,
      );
    },
  );
});

describe("account hook uploads", () => {
  test("storage key escapes the account", (): void => {
    expect(accountHookBundleStorageKey("a/b c", "ff")).toBe(
      "account-hooks/a%2Fb%20c/bundles/ff.mjs",
    );
  });

  test.each([
    [
      {
        name: " _hook-1 ",
        description: " does it ",
        events: ["agent.started", "agent.started", "tool.result"],
        bundle: BUNDLE,
      },
      true,
    ],
    [{ name: "hook", events: ["agent.failed"], bundle: BUNDLE }, true],
    [{ description: "only" }, false],
    [{}, false],
  ])(
    "accepts %#",
    async (input: Upload, requireBundle: boolean): Promise<void> => {
      const result = await normalizeAccountHookUpload(input, {
        requireBundle: requireBundle as true,
      });

      expect(result.description).toBe(
        typeof input["description"] === "string"
          ? input["description"].trim()
          : undefined,
      );
    },
  );

  test.each([
    ["not an object", false],
    [{ events: ["agent.started"], bundle: BUNDLE }, true],
    [{ name: "h", bundle: BUNDLE }, true],
    [{ name: "h", events: ["agent.started"] }, true],
    [{ name: 3 }, false],
    [{ name: "   " }, false],
    [{ name: "1bad" }, false],
    [{ description: "   " }, false],
    [{ description: 1 }, false],
    [{ events: [] }, false],
    [{ events: "x" }, false],
    [{ events: ["nope"] }, false],
    [{ events: [1] }, false],
    [{ bundle: "" }, false],
    [{ bundle: 1 }, false],
    [{ bundle: "x".repeat(1_000_001) }, false],
    [{ bundle: 'import fs from "node:fs";' }, false],
  ])(
    "refuses %#",
    async (input: unknown, requireBundle: boolean): Promise<void> => {
      await expect(
        normalizeAccountHookUpload(input, {
          requireBundle: requireBundle as true,
        }),
      ).rejects.toThrow();
    },
  );
});

describe("harness entry rows", () => {
  test("findHarnessEntry reads the first row of its index", async (): Promise<void> => {
    const seen: string[] = [];
    const builder = {
      eq: function (field: string, value: string) {
        seen.push(`${field}=${value}`);

        return builder;
      },
    };
    const db = {
      query: (_table: string) => ({
        withIndex: (_name: string, range: (q: typeof builder) => unknown) => {
          range(builder);

          return {
            first: async (): Promise<{ entryId: string }> => ({ entryId: "e" }),
          };
        },
      }),
    };

    expect(
      await findHarnessEntry(
        db as never,
        { conversationKey: "c", sessionId: "s" },
        "e",
      ),
    ).toEqual({ entryId: "e" } as never);
    expect(seen).toEqual(["conversationKey=c", "sessionId=s", "entryId=e"]);
  });

  test.each([
    [["a", "b"], { rows: 2, bytes: 1000 }, 2, true],
    [["a", "b", "c"], { rows: 5, bytes: 1000 }, 3, false],
    [["aaaaaaaa", "b"], { rows: 5, bytes: 4 }, 1, true],
    [[], { rows: 5, bytes: 4 }, 0, false],
  ])(
    "takeHarnessEntryBatch %#",
    async (
      entries: string[],
      limits: { rows: number; bytes: number },
      size: number,
      full: boolean,
    ): Promise<void> => {
      const result = await takeHarnessEntryBatch(rows(entries), limits);

      expect(result.batch.length).toBe(size);
      expect(result.full).toBe(full);
    },
  );
});

describe("normalizeUpdatePolicyInput", () => {
  test.each([
    [{}, {}],
    [{ name: "  n " }, { name: "n" }],
    [{ description: null }, { description: null }],
    [{ description: "  d " }, { description: "d" }],
    [{ description: "   " }, { description: undefined }],
    [{ status: "deleted" }, { status: "deleted" }],
    [
      { document: { version: 1, rules: [] } },
      { document: { version: 1, rules: [] } },
    ],
  ])("%#", (input: unknown, expected: unknown): void => {
    expect(normalizeUpdatePolicyInput(input)).toEqual(expected as never);
  });

  test.each([["x"], [{ name: "" }], [{ status: "gone" }]])(
    "refuses %#",
    (input: unknown): void => {
      expect(() => normalizeUpdatePolicyInput(input)).toThrow();
    },
  );
});
