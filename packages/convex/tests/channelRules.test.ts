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
        partition: { by: "conversation", alias: "support" },
      }).partition,
    ).toEqual({ by: "conversation", alias: "support" });

    expect(() =>
      normalizeChannelRecordConfig({
        agentBindings: bindings,
        partition: { by: "conversation" },
      }),
    ).toThrow("config.partition.alias must be a non-empty string");

    expect(() =>
      normalizeChannelRecordConfig({
        agentBindings: bindings,
        partition: { level: "everything" },
      }),
    ).toThrow("must be one of: shared, conversation");
  });

  it("validates the reply target enum", () => {
    expect(() =>
      normalizeChannelRecordConfig({
        agentBindings: bindings,
        replyIn: "maybe",
      }),
    ).toThrow("config.replyIn must be one of: thread, source");
  });

  // Mode moved onto the policy, so a record still naming these must not be
  // accepted and quietly ignored.
  it("rejects the retired policy fields", () => {
    expect(() =>
      normalizeChannelRecordConfig({
        agentBindings: bindings,
        policyMode: "audit",
      }),
    ).toThrow("config.policyMode is not supported");
    expect(() =>
      normalizeChannelRecordConfig({
        agentBindings: bindings,
        threadPolicy: "inline",
      }),
    ).toThrow("config.threadPolicy is not supported");
  });

  it("rejects blank entries in a string list", () => {
    // `policies: [""]` would otherwise persist as a live reference to nothing.
    expect(() =>
      normalizeChannelRecordConfig({
        agentBindings: bindings,
        policies: [""],
      }),
    ).toThrow("config.policies must be an array of non-empty strings");
    expect(() =>
      normalizeChannelRecordConfig({
        agentBindings: bindings,
        denyTools: [" "],
      }),
    ).toThrow("config.denyTools must be an array of non-empty strings");
  });

  it("defaults a role with no members to an empty list", () => {
    expect(
      normalizeChannelRecordConfig({
        agentBindings: bindings,
        tagRoles: [{ roleId: "oncall" }],
      }).tagRoles,
    ).toEqual([{ roleId: "oncall", userIds: [] }]);
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
        config: { agentBindings: bindings, policies: ["policy_1"] },
      }),
    ).toEqual({
      platform: "slack",
      externalId: "C042",
      workspaceRef: "T09",
      name: "#product-eng",
      config: { agentBindings: bindings, policies: ["policy_1"] },
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

  it("rejects an unknown key instead of silently patching nothing", () => {
    // `{descripton: "x"}` normalized to {} and PATCH answered 200 unchanged.
    expect(() =>
      normalizeUpdateChannelRecordInput({ descripton: "typo" }),
    ).toThrow("descripton is not supported");
  });
});
