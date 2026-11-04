import { expect, test } from "bun:test";
import { ACCOUNT_MODEL_PROVIDER_NAMES } from "../../convex/model/modelProviders.ts";
import { validateProviderConfig } from "../src/manifest.ts";
import { env, type EnvRef } from "../src/resources.ts";

test("accepts base_url and baseURL for the custom provider", (): void => {
  expect((): void =>
    validateProviderConfig("a", {
      custom: { apiKey: "k", base_url: "https://llm.example/v1" },
    }),
  ).not.toThrow();
  expect((): void =>
    validateProviderConfig("a", {
      custom: { apiKey: "k", baseURL: "https://llm.example/v1" },
    }),
  ).not.toThrow();
});

test('accepts env("NAME") refs as values (only keys are validated)', (): void => {
  expect((): void =>
    validateProviderConfig("a", {
      custom: { apiKey: env("API_KEY"), baseURL: env("BASE_URL") },
    }),
  ).not.toThrow();
});

test("exposes env as a validated callable deferred-reference accessor", (): void => {
  expect(typeof env).toBe("function");
  expect(env("API_KEY")).toEqual({ __beeblastEnv: true, name: "API_KEY" });
  expect((): EnvRef<"lowercase"> => env("lowercase")).toThrow(
    "env name must match",
  );
  expect(
    (): unknown => (env as unknown as Record<string, unknown>).API_KEY,
  ).toThrow('env.API_KEY is not supported; use env("API_KEY")');
});

test("rejects the camel `baseUrl` typo with a did-you-mean hint", (): void => {
  expect((): void =>
    validateProviderConfig("sale", {
      custom: { apiKey: "k", baseUrl: "https://llm.example/v1" },
    }),
  ).toThrow(
    `Agent "sale" config.provider.custom has unknown option "baseUrl". Did you mean "base_url" or "baseURL"?`,
  );
});

test("passes provider-owned settings through and still catches apiKey typos", (): void => {
  expect((): void =>
    validateProviderConfig("a", {
      vertex: { apiKey: "k", project: "p", location: "us-central1" },
    }),
  ).not.toThrow();
  expect((): void =>
    validateProviderConfig("a", {
      custom: { api_key: "k", baseURL: "https://x/v1" },
    }),
  ).toThrow(`Did you mean "apiKey"?`);
});

test("supports every provider on the shared list, deepseek included", (): void => {
  // Pinned apart from the loop below, which draws its cases from this same list.
  expect(ACCOUNT_MODEL_PROVIDER_NAMES).toContain("deepseek");
  expect(ACCOUNT_MODEL_PROVIDER_NAMES).toContain("vertex");

  for (const name of ACCOUNT_MODEL_PROVIDER_NAMES) {
    const settings =
      name === "custom"
        ? { apiKey: "k", baseURL: "https://x/v1" }
        : { apiKey: "k" };
    expect((): void =>
      validateProviderConfig("a", { [name]: settings }),
    ).not.toThrow();
  }
  expect((): void =>
    validateProviderConfig("a", { nope: { apiKey: "k" } }),
  ).toThrow("is not a supported provider");
});

test("requires a base URL for the custom provider", (): void => {
  expect((): void =>
    validateProviderConfig("a", { custom: { apiKey: "k" } }),
  ).toThrow(
    `config.provider.custom.base_url is required (use "base_url" or "baseURL")`,
  );
});
