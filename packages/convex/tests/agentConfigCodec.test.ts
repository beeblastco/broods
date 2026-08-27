/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import {
  fromNestedAgentConfig,
  toNestedAgentConfig,
} from "../model/agentConfigCodec";

describe("agent config codec", () => {
  // `scheduler` has no flat column, so it only survives a sync by riding in
  // extraConfig. Dropping it let `broods dev` report the agent as updated while
  // the harness kept building its toolset without schedule_task.
  test("round-trips the scheduler branch", () => {
    const flat = fromNestedAgentConfig({
      model: { provider: "custom", modelId: "deepseek-v4-pro" },
      scheduler: { enabled: true },
    });

    expect(flat.extraConfig).toMatchObject({ scheduler: { enabled: true } });
    expect(toNestedAgentConfig(flat).scheduler).toEqual({ enabled: true });
  });
});
