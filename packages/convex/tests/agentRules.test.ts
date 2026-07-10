/** Agent config normalizer parity tests for the Convex config plane. */

import { describe, expect, it } from "bun:test";
import {
    mergeAgentConfig,
    normalizeAgentConfig,
    normalizeCreateAgentInput,
    normalizeUpdateAgentInput,
    redactAgentConfig,
} from "../model/agentRules";
import { collectEnvPlaceholderNames, substituteAccountEnvPlaceholders } from "../model/agentConfigCodec";

describe("agent rules", () => {
    it("normalizes empty configs and rejects non-objects", () => {
        expect(normalizeAgentConfig(null)).toEqual({});
        expect(() => normalizeAgentConfig("bad")).toThrow("config must be an object");
    });

    it("validates representative nested config bounds and enums", () => {
        expect(() => normalizeAgentConfig({ agent: { maxTurn: 101 } })).toThrow("config.agent.maxTurn must be an integer from 1 to 100");
        expect(() => normalizeAgentConfig({ session: { compaction: { maxContextLength: 500_001 } } }))
            .toThrow("config.session.compaction.maxContextLength must be an integer from 1 to 500000");
        expect(() => normalizeAgentConfig({ model: { apiKey: "x" } }))
            .toThrow("config.model.apiKey is not supported; use config.model.providerOptions for provider-specific settings");
        expect(() => normalizeAgentConfig({ model: { provider: "other" } }))
            .toThrow("config.model.provider must be one of: google, openai, anthropic, bedrock, gateway, minimax, custom");
    });

    it("validates public provider URLs and output variants", () => {
        expect(() => normalizeAgentConfig({ provider: { custom: {} } }))
            .toThrow("config.provider.custom.base_url is required");
        expect(() => normalizeAgentConfig({ provider: { custom: { baseUrl: "https://api.example.com" } } }))
            .toThrow(`config.provider.custom.base_url is required (found "baseUrl" — use "base_url" or "baseURL")`);
        expect(() => normalizeAgentConfig({ provider: { custom: { base_url: "http://api.example.com" } } }))
            .toThrow("config.provider.custom.base_url must use https");
        expect(() => normalizeAgentConfig({ provider: { custom: { base_url: "https://localhost" } } }))
            .toThrow("config.provider.custom.base_url must not point to a private or internal address");
        expect(normalizeAgentConfig({ provider: { custom: { base_url: "https://api.example.com" } } }).provider)
            .toEqual({ custom: { baseURL: "https://api.example.com" } });
        expect(normalizeAgentConfig({
            provider: { custom: { base_url: "https://old.example.com", baseURL: "https://api.example.com" } },
        }).provider).toEqual({ custom: { baseURL: "https://old.example.com" } });
        expect(() => normalizeAgentConfig({ model: { output: { type: "object" } } }))
            .toThrow("config.model.output.schema must be an object");
        expect(() => normalizeAgentConfig({ model: { output: { type: "array" } } }))
            .toThrow("config.model.output.element must be an object");
        expect(() => normalizeAgentConfig({ model: { output: { type: "choice", options: [] } } }))
            .toThrow("config.model.output.options must be a non-empty array of strings");
    });

    it("validates workspace references", () => {
        expect(normalizeAgentConfig({ workspaces: [{ name: "repo", workspaceId: "ws_1", sandbox: null }] }).workspaces).toHaveLength(1);
        expect(() => normalizeAgentConfig({ workspaces: [{ name: "bad/name", workspaceId: "ws_1" }] }))
            .toThrow("config.workspaces[0].name must use only letters, numbers, dots, underscores, or hyphens");
        expect(() => normalizeAgentConfig({ workspaces: [{ name: "repo", workspaceId: "ws_1" }, { name: "repo", workspaceId: "ws_2" }] }))
            .toThrow('config.workspaces[1].name "repo" is used more than once');
    });

    it("validates skills, subagents, policies, handoffs, and channels", () => {
        expect(() => normalizeAgentConfig({ skills: { allowed: [1] } })).toThrow("config.skills.allowed must be an array of strings");
        expect(() => normalizeAgentConfig({ subagent: { context: "same" } })).toThrow("config.subagent.context must be one of: new, inherited");
        expect(normalizeAgentConfig({ policy: { enabled: true } }).policy).toBeUndefined();
        expect(() => normalizeAgentConfig({ policy: { policyIds: [1] } })).toThrow("config.policy.policyIds must be an array of strings");
        expect(() => normalizeAgentConfig({ tools: { handoffs: {} } })).toThrow("config.tools.handoffs.pancake is required");
        expect(() => normalizeAgentConfig({ channels: { slack: { id: "slack", workspaceScope: { level: "channel", alias: "x" } } } }))
            .toThrow("config.channels.slack.workspaceScope.alias is only supported when config.channels.slack.workspaceScope.level is conversation");
        expect(() => normalizeAgentConfig({ channels: { zalo: { id: "zalo", webhookSecret: "short" } } }))
            .toThrow("config.channels.zalo.webhookSecret must be 8 to 256 characters");
    });

    it("merges patches and redacts secrets", () => {
        const merged = mergeAgentConfig(
            { provider: { openai: { apiKey: "secret", baseURL: "https://api.example.com" } }, skills: { allowed: ["acct/old"] } },
            { provider: { openai: { apiKey: "********", baseURL: null } }, skills: { allowed: ["acct/new"] } },
        );
        expect(merged).toEqual({ provider: { openai: { apiKey: "secret" } }, skills: { allowed: ["acct/new"] } });
        expect(redactAgentConfig({ provider: { openai: { apiKey: "secret" } } })).toEqual({ provider: { openai: { apiKey: "********" } } });
        expect(redactAgentConfig({ provider: { openai: { apiKey: "${OVH_API_KEY}" } } }))
            .toEqual({ provider: { openai: { apiKey: "${OVH_API_KEY}" } } });
        // A secret mixing literal material with a placeholder is still a secret.
        expect(redactAgentConfig({ provider: { openai: { apiKey: "sk_live_abc${OVH_API_KEY}" } } }))
            .toEqual({ provider: { openai: { apiKey: "********" } } });
    });

    it("collects and substitutes only valid account env placeholders recursively", () => {
        const source = { provider: { apiKey: "${OVH_API_KEY}" }, list: ["prefix-${REGION}", "${lowercase}"] };
        expect([...collectEnvPlaceholderNames(source)].sort()).toEqual(["OVH_API_KEY", "REGION"]);
        expect(substituteAccountEnvPlaceholders(source, { OVH_API_KEY: "secret", REGION: "eu" }))
            .toEqual({ provider: { apiKey: "secret" }, list: ["prefix-eu", "${lowercase}"] });
        // Dangerous keys are dropped, not copied, when rebuilding the config.
        const polluted = JSON.parse('{"__proto__": {"x": 1}, "safe": "${REGION}"}');
        const substituted = substituteAccountEnvPlaceholders(polluted, { REGION: "eu" }) as Record<string, unknown>;
        expect(substituted).toEqual({ safe: "eu" });
        expect(Object.getPrototypeOf(substituted)).toBe(Object.prototype);
    });

    it("normalizes create and update inputs", () => {
        expect(normalizeCreateAgentInput({ name: " Main ", description: " Agent ", config: null })).toEqual({
            name: "Main",
            description: "Agent",
            config: {},
        });
        expect(normalizeUpdateAgentInput({ agent: { maxTurn: 3 } }, {
            name: " Next ",
            description: null,
            status: "disabled",
            config: { agent: { maxTurn: 4 } },
        })).toEqual({
            name: "Next",
            description: null,
            status: "disabled",
            config: { agent: { maxTurn: 4 } },
        });
        expect(() => normalizeUpdateAgentInput({}, { status: "deleted" })).toThrow("status must be one of: active, disabled");
    });
});
