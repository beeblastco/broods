import { afterEach, describe, expect, test, vi } from "vitest";
import { SELF_HOST_ISSUER } from "../model/selfHostAuth";

// The variables each kind of deployment has. A branch of auth.config.ts that
// reads anything else fails the deploy, so a new variable goes here first.
const WORKOS_DEPLOYMENT = {
  BROODS_AUTH_PROVIDER: "workos",
  WORKOS_CLIENT_ID: "client_test",
};
const SELF_HOST_DEPLOYMENT = {
  BROODS_AUTH_PROVIDER: "self-host",
  BROODS_SESSION_JWKS: '{"keys":[]}',
};

// Mirrors the backend's auth config evaluation: `process.env` is a Proxy whose
// only trap is `get`, and a read of an unset variable throws.
function deploymentEnv(variables: Record<string, string>): NodeJS.ProcessEnv {
  return new Proxy<NodeJS.ProcessEnv>(
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
}

async function evaluateAuthConfig(
  variables: Record<string, string>,
): Promise<{ providers: ReadonlyArray<{ issuer: string }> }> {
  vi.stubGlobal("process", { env: deploymentEnv(variables) });
  vi.resetModules();
  const { default: authConfig } = await import("../auth.config");

  return authConfig;
}

describe("auth.config.ts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("a WorkOS deployment reads only its own variables", async () => {
    const { providers } = await evaluateAuthConfig(WORKOS_DEPLOYMENT);

    expect(providers.map((provider) => provider.issuer)).toEqual([
      "https://api.workos.com/",
      "https://api.workos.com/user_management/client_test",
    ]);
  });

  test("a self-hosted deployment reads only its own variables", async () => {
    const { providers } = await evaluateAuthConfig(SELF_HOST_DEPLOYMENT);

    expect(providers.map((provider) => provider.issuer)).toEqual([
      SELF_HOST_ISSUER,
    ]);
  });

  test("a deployment without a provider fails the deploy", async () => {
    await expect(evaluateAuthConfig({})).rejects.toThrow(
      "BROODS_AUTH_PROVIDER",
    );
  });
});
