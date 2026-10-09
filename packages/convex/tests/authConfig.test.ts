import { afterEach, describe, expect, test, vi } from "vitest";
import { SELF_HOST_ISSUER } from "../model/selfHostAuth";

// Evaluates auth.config.ts the way the backend does at deploy time: with a
// `process.env` whose only trap is `get`, where reading an unset variable
// throws. `variables` is everything a deployment of that kind has, so a branch
// that reads anything else fails here before it fails the deploy.
async function evaluateAuthConfig(
  variables: Record<string, string>,
): Promise<typeof import("../auth.config").default> {
  const env = new Proxy<NodeJS.ProcessEnv>(
    {},
    {
      get: (_target, name): string => {
        if (typeof name === "string" && name in variables)
          return variables[name] as string;
        throw new Error(
          `Environment variable ${String(name)} is used in auth config file but its value was not set`,
        );
      },
    },
  );
  vi.stubGlobal("process", { ...process, env: env });
  vi.resetModules();
  const { default: authConfig } = await import("../auth.config");

  return authConfig;
}

describe("auth.config.ts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("a WorkOS deployment reads only its own variables", async () => {
    const { providers } = await evaluateAuthConfig({
      BROODS_AUTH_PROVIDER: "workos",
      WORKOS_CLIENT_ID: "client_test",
    });

    expect(providers.map((provider) => provider.issuer)).toEqual([
      "https://api.workos.com/",
      "https://api.workos.com/user_management/client_test",
    ]);
  });

  test("a self-hosted deployment reads only its own variables", async () => {
    const { providers } = await evaluateAuthConfig({
      BROODS_AUTH_PROVIDER: "self-host",
      BROODS_SESSION_JWKS: '{"keys":[]}',
    });

    expect(providers.map((provider) => provider.issuer)).toEqual([
      SELF_HOST_ISSUER,
    ]);
  });
});
