import { describe, expect, test } from "vitest";
import {
  analyticsBatch,
  analyticsMode,
  durationBucket,
  parseAnalyticsEvents,
} from "../model/productAnalytics";

describe("product analytics", () => {
  test("off unless the env names a mode", () => {
    expect(analyticsMode(undefined)).toBeNull();
    expect(analyticsMode("true")).toBeNull();
    expect(analyticsMode("anonymous")).toBe("anonymous");
    expect(analyticsMode("org")).toBe("org");
  });

  test("a beacon keeps only known events and their own properties", () => {
    expect(
      parseAnalyticsEvents({
        analytics: [
          { name: "dashboard_tab_opened", tab: "usage", email: "a@b.c" },
          { name: "agent_created", provider: "anthropic", prompt: "secret" },
          { name: "trace_opened", traceId: "abc" },
          { name: "run_finished", status: "completed" },
          { name: "made_up" },
          { name: "dashboard_tab_opened" },
        ],
      }),
    ).toEqual([
      { name: "dashboard_tab_opened", tab: "usage" },
      { name: "agent_created", provider: "anthropic" },
      { name: "trace_opened" },
    ]);
    expect(parseAnalyticsEvents({ events: [] })).toEqual([]);
  });

  test("the batch names the install, never a person, and the org only when given", () => {
    const batch = analyticsBatch([{ name: "trace_opened" }], {
      apiKey: "phc_x",
      instanceId: "0123456789abcdef",
      source: "dashboard",
      at: 1_760_000_000_000,
    });

    expect(batch).toEqual({
      api_key: "phc_x",
      batch: [
        {
          event: "trace_opened",
          distinct_id: "0123456789abcdef",
          properties: {
            instance_id: "0123456789abcdef",
            source: "dashboard",
            $process_person_profile: false,
          },
          timestamp: "2025-10-09T08:53:20.000Z",
        },
      ],
    });
    expect(
      analyticsBatch([{ name: "trace_opened" }], {
        apiKey: "phc_x",
        instanceId: "i",
        orgId: "org_1",
        source: "core",
        at: 0,
      }).batch[0].properties.org_id,
    ).toBe("org_1");
  });

  test("a duration leaves as a bucket", () => {
    expect(durationBucket(9_999)).toBe("<10s");
    expect(durationBucket(59_000)).toBe("<1m");
    expect(durationBucket(599_000)).toBe("<10m");
    expect(durationBucket(600_000)).toBe(">10m");
  });
});
