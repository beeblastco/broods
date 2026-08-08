import { describe, expect, test } from "bun:test";
import { buildOtlpLogPayload, parseOtlpHeaders } from "../app/lib/otlpLogs";
import { routePattern, type PerfEvent } from "../app/lib/perfReport";

function event(overrides: Partial<PerfEvent> = {}): PerfEvent {
  return {
    name: "web-vital.LCP",
    value: 1234.5,
    unit: "ms",
    route: "/[projectId]",
    at: 1_700_000_000_000,
    ...overrides,
  };
}

type Attribute = { key: string; value: Record<string, unknown> };
type Record_ = {
  attributes: Attribute[];
  body: { stringValue: string };
  timeUnixNano: string;
};

function records(payload: { resourceLogs: unknown[] }): Record_[] {
  const resource = payload.resourceLogs[0] as {
    scopeLogs: Array<{ logRecords: Record_[] }>;
  };

  return resource.scopeLogs[0].logRecords;
}

function attribute(record: Record_, key: string) {
  return record.attributes.find((a) => a.key === key)?.value;
}

describe("parseOtlpHeaders", () => {
  test("parses core's K=V,K2=V2 form", () => {
    expect(parseOtlpHeaders("Authorization=Basic abc,X-Scope=team")).toEqual({
      Authorization: "Basic abc",
      "X-Scope": "team",
    });
  });

  test("keeps '=' inside a value (base64 padding)", () => {
    expect(parseOtlpHeaders("Authorization=Basic dXNlcjpwYXNz==")).toEqual({
      Authorization: "Basic dXNlcjpwYXNz==",
    });
  });

  test("returns empty for unset or malformed input", () => {
    expect(parseOtlpHeaders(undefined)).toEqual({});
    expect(parseOtlpHeaders("=novalue")).toEqual({});
  });
});

describe("buildOtlpLogPayload", () => {
  test("service.name is the only resource attribute, and carries the stage", () => {
    const payload = buildOtlpLogPayload([event()], {
      serviceName: "dev-broods-dashboard-pod",
    });
    const resource = payload.resourceLogs[0] as {
      resource: { attributes: Attribute[] };
    };

    // The collector promotes resource attributes to Loki index labels, so a
    // per-project key here would be unbounded cardinality.
    expect(resource.resource.attributes).toEqual([
      {
        key: "service.name",
        value: { stringValue: "dev-broods-dashboard-pod" },
      },
    ]);
  });

  test("falls back to a default service name when the pod sets none", () => {
    const payload = buildOtlpLogPayload([event()], {});
    const resource = payload.resourceLogs[0] as {
      resource: { attributes: Attribute[] };
    };

    expect(resource.resource.attributes[0].value).toEqual({
      stringValue: "broods-dashboard",
    });
  });

  test("carries metric, value, unit and route as record attributes", () => {
    const record = records(buildOtlpLogPayload([event()], {}))[0];

    expect(record.body.stringValue).toBe("web-vital.LCP");
    expect(attribute(record, "metric")).toEqual({
      stringValue: "web-vital.LCP",
    });
    expect(attribute(record, "value")).toEqual({ doubleValue: 1234.5 });
    expect(attribute(record, "unit")).toEqual({ stringValue: "ms" });
    expect(attribute(record, "route")).toEqual({ stringValue: "/[projectId]" });
  });

  test("maps each custom attribute to its OTLP value type", () => {
    const record = records(
      buildOtlpLogPayload(
        [
          event({
            attributes: { rating: "good", nodes: 12, over_budget: false },
          }),
        ],
        {},
      ),
    )[0];

    expect(attribute(record, "rating")).toEqual({ stringValue: "good" });
    expect(attribute(record, "nodes")).toEqual({ doubleValue: 12 });
    expect(attribute(record, "over_budget")).toEqual({ boolValue: false });
  });

  test("stamps the timestamp in nanoseconds", () => {
    const record = records(buildOtlpLogPayload([event()], {}))[0];

    expect(record.timeUnixNano).toBe("1700000000000000000");
  });

  test("batches every event into one scope", () => {
    const payload = buildOtlpLogPayload(
      [event(), event({ name: "long-task" })],
      {},
    );

    expect(records(payload)).toHaveLength(2);
  });
});

describe("routePattern", () => {
  test("collapses a project id to its segment name", () => {
    expect(routePattern("/j97abc123/dashboard")).toBe("/[projectId]/dashboard");
    expect(routePattern("/j97abc123")).toBe("/[projectId]");
  });

  test("leaves known top-level routes alone", () => {
    expect(routePattern("/projects")).toBe("/projects");
    expect(routePattern("/settings/org")).toBe("/settings/org");
  });

  test("handles the root path", () => {
    expect(routePattern("/")).toBe("/");
  });
});
