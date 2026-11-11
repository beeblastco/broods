import { describe, expect, test } from "bun:test";
import type { AgentConfig } from "../../../../apps/core/src/shared/domain/agent-config.ts";
import { configuredMaxTurn } from "../../../../apps/core/src/shared/domain/agent-config.ts";

describe("configuredMaxTurn", (): void => {
  test("a limit is returned as set", (): void => {
    const config: AgentConfig = { agent: { maxTurn: 6 } };

    expect(configuredMaxTurn(config)).toBe(6);
  });

  test("zero means no limit", (): void => {
    const config: AgentConfig = { agent: { maxTurn: 0 } };

    expect(configuredMaxTurn(config)).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("an agent with no limit set has none to report", (): void => {
    expect(configuredMaxTurn({})).toBeUndefined();
  });
});
