import { expect, test } from "bun:test";
import { ACCOUNT_MODEL_PROVIDER_NAMES } from "../../convex/model/modelProviders.ts";
import {
  KNOWN_PROVIDER_NAMES,
  validateProviderConfig,
} from "../src/manifest.ts";
import { env } from "../src/resources.ts";

test("accepts base_url and baseURL for the custom provider", () => {
  expect(() =>
    validateProviderConfig("a", {
      custom: { apiKey: "k", base_url: "https://llm.example/v1" },
    }),
  ).not.toThrow();
  expect(() =>
    validateProviderConfig("a", {
      custom: { apiKey: "k", baseURL: "https://llm.example/v1" },
    }),
  ).not.toThrow();
});

test('accepts env("NAME") refs as values (only keys are validated)', () => {
  expect(() =>
    validateProviderConfig("a", {
      custom: { apiKey: env("API_KEY"), baseURL: env("BASE_URL") },
    }),
  ).not.toThrow();
});

test("exposes env as a validated callable deferred-reference accessor", () => {
  expect(typeof env).toBe("function");
  expect(env("API_KEY")).toEqual({ __beeblastEnv: true, name: "API_KEY" });
  expect(() => env("lowercase")).toThrow("env name must match");
  expect(() => (env as unknown as Record<string, unknown>).API_KEY).toThrow(
    'env.API_KEY is not supported; use env("API_KEY")',
  );
});

test("rejects the camel `baseUrl` typo with a did-you-mean hint", () => {
  expect(() =>
    validateProviderConfig("sale", {
      custom: { apiKey: "k", baseUrl: "https://llm.example/v1" },
    }),
  ).toThrow(
    `Agent "sale" config.provider.custom has unknown option "baseUrl" — did you mean "base_url" or "baseURL"?`,
  );
});

test("passes provider-owned settings through and still catches apiKey typos", () => {
  // Anything the provider's own AI SDK factory accepts is not the SDK's business.
  expect(() =>
    validateProviderConfig("a", {
      vertex: { apiKey: "k", project: "p", location: "us-central1" },
    }),
  ).not.toThrow();
  expect(() =>
    validateProviderConfig("a", {
      custom: { api_key: "k", baseURL: "https://x/v1" },
    }),
  ).toThrow(`did you mean "apiKey"?`);
});

test("supports every provider on the shared list, deepseek included", () => {
  expect(KNOWN_PROVIDER_NAMES).toEqual([...ACCOUNT_MODEL_PROVIDER_NAMES]);
  expect(() =>
    validateProviderConfig("a", { deepseek: { apiKey: "k" } }),
  ).not.toThrow();
});

test("requires a base URL for the custom provider", () => {
  expect(() =>
    validateProviderConfig("a", { custom: { apiKey: "k" } }),
  ).toThrow(
    `config.provider.custom.base_url is required (use "base_url" or "baseURL")`,
  );
});

test("rejects unsupported provider names", () => {
  expect(() =>
    validateProviderConfig("a", { madeup: { apiKey: "k" } }),
  ).toThrow(`config.provider.madeup is not a supported provider`);
});

test("is a no-op when no provider block is present", () => {
  expect(() => validateProviderConfig("a", undefined)).not.toThrow();
});
