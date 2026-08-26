/**
 * `config.connectors` normalization tests (ticket 19) — mirrors the
 * scheduler-config accept/reject discipline.
 */

import { describe, expect, it } from "bun:test";
import { normalizeConnectorsConfig } from "../src/shared/domain/agent-config.ts";

describe("normalizeConnectorsConfig", () => {
  it("accepts absent, empty, and well-formed configs", () => {
    expect(() => normalizeConnectorsConfig(undefined)).not.toThrow();
    expect(() => normalizeConnectorsConfig({})).not.toThrow();
    expect(() =>
      normalizeConnectorsConfig({
        allowed: [
          { provider: "github", connectorId: "c1", enabled: true },
          { provider: "mcp", connectorId: "c2", enabled: false },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects malformed shapes with specific errors", () => {
    expect(() => normalizeConnectorsConfig("nope")).toThrow(
      "config.connectors must be an object",
    );
    expect(() => normalizeConnectorsConfig({ allowed: "x" })).toThrow(
      "config.connectors.allowed must be an array",
    );
    expect(() =>
      normalizeConnectorsConfig({
        allowed: [{ connectorId: "c", enabled: true }],
      }),
    ).toThrow("allowed[0].provider must be a non-empty string");
    expect(() =>
      normalizeConnectorsConfig({
        allowed: [{ provider: "github", enabled: true }],
      }),
    ).toThrow("allowed[0].connectorId must be a non-empty string");
    expect(() =>
      normalizeConnectorsConfig({
        allowed: [{ provider: "github", connectorId: "c", enabled: "yes" }],
      }),
    ).toThrow("allowed[0].enabled must be a boolean");
  });
});
