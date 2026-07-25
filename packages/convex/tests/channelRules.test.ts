/** Validation tests for the channel-record config-plane rules. */

import { describe, expect, it } from "vitest";
import {
  normalizeChannelRecordConfig,
  normalizeCreateChannelRecordInput,
  normalizeUpdateChannelRecordInput,
} from "../model/channelRules";

const bindings = [{ agentId: "agent_1" }];

describe("normalizeChannelRecordConfig", () => {
  it("keeps only the fields that were supplied", () => {
    expect(
      normalizeChannelRecordConfig({
        agentBindings: [{ agentId: "agent_1", isDefault: true }],
        instructions: "  Answer as the sales desk.  ",
      }),
    ).toEqual({
      agentBindings: [{ agentId: "agent_1", isDefault: true }],
      instructions: "Answer as the sales desk.",
    });
  });

  it("requires at least one agent binding", () => {
    expect(() => normalizeChannelRecordConfig({})).toThrow(
      "config.agentBindings must be a non-empty array",
    );
    expect(() => normalizeChannelRecordConfig({ agentBindings: [] })).toThrow(
      "config.agentBindings must be a non-empty array",
    );
  });

  it("allows at most one default binding", () => {
    expect(() =>
      normalizeChannelRecordConfig({
        agentBindings: [
          { agentId: "a", isDefault: true },
          { agentId: "b", isDefault: true },
        ],
      }),
    ).toThrow("only one binding as default");
  });

  it("rejects unknown keys so a typo is not silently stored", () => {
    expect(() =>
      normalizeChannelRecordConfig({ agentBindings: bindings, botToken: "x" }),
    ).toThrow("config.botToken is not supported");
  });

  it("validates the workspace scope shape", () => {
    expect(
      normalizeChannelRecordConfig({
        agentBindings: bindings,
        workspaceScope: { level: "conversation", alias: "support" },
      }).workspaceScope,
    ).toEqual({ level: "conversation", alias: "support" });

    expect(() =>
      normalizeChannelRecordConfig({
        agentBindings: bindings,
        workspaceScope: { level: "conversation" },
      }),
    ).toThrow("config.workspaceScope.alias must be a non-empty string");

    expect(() =>
      normalizeChannelRecordConfig({
        agentBindings: bindings,
        workspaceScope: { level: "everything" },
      }),
    ).toThrow("must be one of: channel, conversation");
  });

  it("validates thread policy and policy mode enums", () => {
    expect(() =>
      normalizeChannelRecordConfig({
        agentBindings: bindings,
        threadPolicy: "maybe",
      }),
    ).toThrow("config.threadPolicy must be one of: always-thread, inline");

    expect(() =>
      normalizeChannelRecordConfig({
        agentBindings: bindings,
        policyMode: "warn",
      }),
    ).toThrow("config.policyMode must be one of: enforce, audit");
  });

  it("defaults a role with no members to an empty list", () => {
    expect(
      normalizeChannelRecordConfig({
        agentBindings: bindings,
        tagRoles: [{ roleId: "oncall" }],
      }).tagRoles,
    ).toEqual([{ roleId: "oncall", actorIds: [] }]);
  });
});

describe("normalizeCreateChannelRecordInput", () => {
  it("requires the place it identifies", () => {
    expect(() =>
      normalizeCreateChannelRecordInput({
        externalId: "C1",
        name: "#eng",
        config: { agentBindings: bindings },
      }),
    ).toThrow("platform must be a non-empty string");

    expect(() =>
      normalizeCreateChannelRecordInput({
        platform: "slack",
        name: "#eng",
        config: { agentBindings: bindings },
      }),
    ).toThrow("externalId must be a non-empty string");
  });

  it("accepts a full record", () => {
    expect(
      normalizeCreateChannelRecordInput({
        platform: "slack",
        externalId: "C042",
        workspaceRef: "T09",
        name: "#product-eng",
        config: { agentBindings: bindings, policyIds: ["policy_1"] },
      }),
    ).toEqual({
      platform: "slack",
      externalId: "C042",
      workspaceRef: "T09",
      name: "#product-eng",
      config: { agentBindings: bindings, policyIds: ["policy_1"] },
    });
  });
});

describe("normalizeUpdateChannelRecordInput", () => {
  it("returns an empty patch when nothing was supplied", () => {
    expect(normalizeUpdateChannelRecordInput({})).toEqual({});
  });

  it("maps an explicit null to a cleared field", () => {
    expect(
      normalizeUpdateChannelRecordInput({
        description: null,
        workspaceRef: null,
      }),
    ).toEqual({ description: null, workspaceRef: null });
  });

  it("rejects an unknown status", () => {
    expect(() =>
      normalizeUpdateChannelRecordInput({ status: "archived" }),
    ).toThrow("status must be one of: active, deleted");
  });
});
