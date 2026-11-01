/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "../_generated/api";
import { modelRates } from "../logs";
import {
  canonicalModelProvider,
  estimateModelTokenCost,
} from "../model/modelPricing";
import { parseInlinePrices, parseModelsDevRates } from "../model/modelsDev";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

describe("model pricing", () => {
  it("normalizes SDK providers", () => {
    expect(canonicalModelProvider("amazon-bedrock")).toBe("bedrock");
    expect(canonicalModelProvider("google-vertex")).toBe("google");
  });

  it("prices cache reads and writes at their own rate, not the input rate", () => {
    // inputTokens is the SDK total: 1M uncached + 1M cache read + 1M cache write.
    const cost = estimateModelTokenCost(
      { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0.25 },
      {
        inputTokens: 3_000_000,
        outputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
      },
    );

    expect(cost).toEqual({
      input: 0.25,
      output: 2,
      cacheRead: 0.025,
      cacheWrite: 0.25,
      total: 2.525,
    });
  });

  it("returns null instead of silently pricing an unknown model", () => {
    expect(
      estimateModelTokenCost(undefined, {
        inputTokens: 100,
        outputTokens: 100,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBeNull();
  });

  it("files models.dev rates under each agent provider that reads them", () => {
    const gpt = { modelId: "gpt-5.5", input: 5, output: 30, cacheRead: 0.5 };
    const providers = parseModelsDevRates({
      "amazon-bedrock": {
        models: {
          "us.anthropic.claude-sonnet-5-5": {
            cost: { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 },
          },
        },
      },
      openai: {
        models: {
          "GPT-5.5": { cost: { input: 5, output: 30, cache_read: 0.5 } },
          "gpt-image-2": { cost: { input: 5 } },
          "free-preview": {},
          "null-entry": null,
          "gpt-broken": { cost: { input: -1, output: 4 } },
        },
      },
      "unmapped-provider": {
        models: { anything: { cost: { input: 1, output: 1 } } },
      },
    });

    // chatgpt reads OpenAI's rates; a missing cache-write rate is the input
    // rate; a negative rate drops the model.
    expect(providers).toEqual([
      {
        provider: "bedrock",
        models: [
          {
            modelId: "us.anthropic.claude-sonnet-5-5",
            input: 2,
            output: 10,
            cacheRead: 0.1,
            cacheWrite: 2.5,
          },
        ],
      },
      { provider: "chatgpt", models: [{ ...gpt, cacheWrite: 5 }] },
      { provider: "openai", models: [{ ...gpt, cacheWrite: 5 }] },
    ]);
  });

  it("hands usage the stored rates under the names its buckets use", async () => {
    const tt = convexTest(schema, modules);
    const rates = { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 5 };
    const models = [{ modelId: "gpt-5.5", ...rates }];
    await tt.mutation(internal.modelPrices.store.storeCatalogue, {
      providers: [
        { provider: "openai", models: models },
        { provider: "chatgpt", models: models },
      ],
      mirror: false,
    });

    const priced = await tt.run(
      async (ctx) =>
        await modelRates(ctx, [
          { modelProvider: "openai", modelId: "GPT-5.5" },
          { modelProvider: "openai", modelId: "gpt-5.5-2026-04-23" },
          { modelProvider: "chatgpt", modelId: "gpt-5.5" },
          { modelProvider: "custom", modelId: "gpt-5.5" },
        ]),
    );

    // A dated snapshot falls back to its alias's rates.
    expect(priced).toEqual([
      { modelProvider: "openai", modelId: "GPT-5.5", ...rates },
      { modelProvider: "openai", modelId: "gpt-5.5-2026-04-23", ...rates },
      { modelProvider: "chatgpt", modelId: "gpt-5.5", ...rates },
    ]);
  });

  it("reads the org's own prices and refuses a malformed one", () => {
    expect(
      parseInlinePrices(
        '{"custom":{"GPT-OSS-120B":{"input":0.1,"output":0.5,"cacheRead":0.01}}}',
      ),
    ).toEqual([
      {
        provider: "custom",
        models: [
          { modelId: "gpt-oss-120b", input: 0.1, output: 0.5, cacheRead: 0.01 },
        ],
      },
    ]);
    expect(parseInlinePrices("")).toEqual([]);
    for (const [raw, problem] of [
      ["not json", "BROODS_MODEL_PRICES"],
      ["[]", "object keyed by agent provider"],
      ['{"nope":{"m":{"input":1,"output":1}}}', "unknown provider"],
      ['{"openai":null}', "must map model ids"],
      ['{"openai":{}}', "must map model ids"],
      ['{"openai":{"m":null}}', "must be an object of rates"],
      ['{"openai":{"m":{"input":-1,"output":1}}}', "non-negative"],
      [
        '{"openai":{"m":{"input":1,"output":1,"cacheRead":"0.1"}}}',
        "non-negative",
      ],
      [
        '{"openai":{"m":{"input":3,"output":15,"cache_read":0.3}}}',
        "unknown keys cache_read",
      ],
      [
        '{"custom":{"GPT-OSS":{"input":1,"output":2},"gpt-oss":{"input":5,"output":9}}}',
        "lists gpt-oss twice",
      ],
    ]) {
      expect(() => parseInlinePrices(raw)).toThrow(problem);
    }
  });

  it("lets the org's rates win over the catalogue, dated snapshots and missing cache rates included", async () => {
    const tt = convexTest(schema, modules);
    const listed = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
    await tt.mutation(internal.modelPrices.store.storeCatalogue, {
      providers: [
        {
          provider: "anthropic",
          models: [
            { modelId: "claude-sonnet-5-5", ...listed },
            { modelId: "claude-sonnet-5-5-20260101", ...listed },
          ],
        },
      ],
      mirror: false,
    });
    await tt.mutation(internal.modelPrices.store.storeOverrides, {
      providers: [
        {
          provider: "anthropic",
          models: [{ modelId: "claude-sonnet-5-5", input: 2, output: 10 }],
        },
      ],
    });

    const priced = await tt.run(
      async (ctx) =>
        await modelRates(ctx, [
          { modelProvider: "anthropic", modelId: "claude-sonnet-5-5-20260101" },
        ]),
    );

    expect(priced).toEqual([
      {
        modelProvider: "anthropic",
        modelId: "claude-sonnet-5-5-20260101",
        input: 2,
        output: 10,
        cacheRead: 0.3,
        cacheWrite: 3.75,
      },
    ]);
  });

  it("keeps a provider the catalogue drops, clears on request, and mirrors the org's rates", async () => {
    const tt = convexTest(schema, modules);
    const rates = { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 5 };
    const providers = async (
      table: "modelPrices" | "modelPriceOverrides",
    ): Promise<string[]> =>
      await tt.run(async (ctx) =>
        (await ctx.db.query(table).collect()).map((doc) => doc.provider).sort(),
      );
    const catalogue = (names: string[], mirror: boolean): Promise<null> =>
      tt.mutation(internal.modelPrices.store.storeCatalogue, {
        providers: names.map((name) => ({
          provider: name,
          models: [{ modelId: "m", ...rates }],
        })),
        mirror: mirror,
      });

    await catalogue(["anthropic", "openai"], false);
    await catalogue(["openai"], false);
    expect(await providers("modelPrices")).toEqual(["anthropic", "openai"]);
    await catalogue([], true);
    expect(await providers("modelPrices")).toEqual([]);

    await tt.mutation(internal.modelPrices.store.storeOverrides, {
      providers: [
        { provider: "custom", models: [{ modelId: "m", input: 1, output: 2 }] },
      ],
    });
    expect(await providers("modelPriceOverrides")).toEqual(["custom"]);
    await tt.mutation(internal.modelPrices.store.storeOverrides, {
      providers: [],
    });
    expect(await providers("modelPriceOverrides")).toEqual([]);
  });
});
