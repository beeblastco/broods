/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { modelRates } from "../logs";
import {
  canonicalModelProvider,
  estimateModelTokenCost,
} from "../model/modelPricing";
import { parseInlinePrices, parseModelsDevRates } from "../model/modelsDev";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");
const CRAWL = { url: "https://models.dev/api.json", etag: '"v1"', inline: "" };

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
    const stored = { models: [{ modelId: "gpt-5.5", ...rates }] };
    await tt.mutation(internal.modelPrices.store.store, {
      crawled: [
        { provider: "openai", ...stored },
        { provider: "chatgpt", ...stored },
      ],
      inline: [],
      crawl: CRAWL,
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
    expect(
      await tt.run(async (ctx) => await ctx.db.query("modelPrices").collect()),
    ).toHaveLength(2);
  });

  it("reads the org's own prices and refuses a malformed one", () => {
    expect(
      parseInlinePrices(
        '{"custom":{"GPT-OSS-120B":{"input":0.1,"output":0.5}}}',
      ),
    ).toEqual([
      {
        provider: "custom",
        models: [
          {
            modelId: "gpt-oss-120b",
            input: 0.1,
            output: 0.5,
            cacheRead: 0.1,
            cacheWrite: 0.1,
          },
        ],
      },
    ]);
    expect(parseInlinePrices("")).toEqual([]);
    expect(() =>
      parseInlinePrices('{"nope":{"m":{"input":1,"output":1}}}'),
    ).toThrow("unknown provider");
    expect(() =>
      parseInlinePrices('{"openai":{"m":{"input":-1,"output":1}}}'),
    ).toThrow("non-negative");
    expect(() => parseInlinePrices('{"openai":null}')).toThrow(
      "BROODS_MODEL_PRICES",
    );
    expect(() => parseInlinePrices('{"openai":{}}')).toThrow("lists no models");
    expect(() =>
      parseInlinePrices(
        '{"anthropic":{"m":{"input":3,"output":15,"cache_read":0.3}}}',
      ),
    ).toThrow("unknown keys cache_read");
  });

  it("applies inline prices over the crawl and mirrors both sources", async () => {
    const tt = convexTest(schema, modules);
    const rates = { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 5 };
    const inlineJson = '{"openai":{"gpt-5.5":{"input":1,"output":2}}}';
    const crawl = (input: number, withInline: boolean): Promise<null> =>
      tt.mutation(internal.modelPrices.store.store, {
        crawled: [
          {
            provider: "openai",
            models: [{ modelId: "gpt-5.5", ...rates, input: input }],
          },
        ],
        inline: withInline
          ? [
              {
                provider: "openai",
                models: [{ modelId: "gpt-5.5", ...rates, input: 1 }],
              },
              { provider: "custom", models: [{ modelId: "mine", ...rates }] },
            ]
          : [],
        crawl: { ...CRAWL, inline: withInline ? inlineJson : "" },
      });
    const stored = async (
      provider: string,
    ): Promise<Doc<"modelPrices"> | null> =>
      await tt.run(
        async (ctx) =>
          await ctx.db
            .query("modelPrices")
            .withIndex("by_provider", (q) => q.eq("provider", provider))
            .unique(),
      );

    await crawl(5, true);
    expect((await stored("openai"))?.models[0].input).toBe(1);
    expect((await stored("custom"))?.models).toEqual([
      { modelId: "mine", ...rates },
    ]);
    expect(await tt.query(internal.modelPrices.store.crawlState, {})).toEqual({
      ...CRAWL,
      inline: inlineJson,
    });

    // Inline prices removed: the crawl's rate returns, the inline-only provider goes.
    await crawl(500, false);
    expect((await stored("openai"))?.models[0].input).toBe(500);
    expect(await stored("custom")).toBeNull();

    // Both sources unset: the table empties, and that empty state is current,
    // so the next crawl does not write again.
    await tt.mutation(internal.modelPrices.store.store, {
      crawled: [],
      inline: [],
      crawl: { url: "", etag: "", inline: "" },
    });
    expect(await stored("openai")).toBeNull();
    expect(await tt.query(internal.modelPrices.store.crawlState, {})).toEqual({
      url: "",
      etag: "",
      inline: "",
    });
  });

  it("lets an inline rate on an alias replace the crawl's dated snapshots", async () => {
    const tt = convexTest(schema, modules);
    const listed = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
    const negotiated = {
      input: 2,
      output: 10,
      cacheRead: 0.2,
      cacheWrite: 2.5,
    };
    await tt.mutation(internal.modelPrices.store.store, {
      crawled: [
        {
          provider: "anthropic",
          models: [
            { modelId: "claude-sonnet-5-5", ...listed },
            { modelId: "claude-sonnet-5-5-20260101", ...listed },
          ],
        },
      ],
      inline: [
        {
          provider: "anthropic",
          models: [{ modelId: "claude-sonnet-5-5", ...negotiated }],
        },
      ],
      crawl: CRAWL,
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
        ...negotiated,
      },
    ]);
  });
});
