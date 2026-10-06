import type { CliManifest } from "../../../packages/broods/src/contracts.ts";
import { BroodsSyncClient } from "../../../packages/broods/src/sync.ts";
import { assertStep, type VerifyContext } from "../harness.ts";

/**
 * The custom provider through the config plane: a private endpoint is refused
 * at create, a public one is kept with its headers, and a credential header a
 * code sync resolved reads back redacted. Running bash on it needs a public
 * server, which core refuses to fake, so the exec itself is covered by the
 * core test against a loopback TLS server.
 */
export async function customSandbox(context: VerifyContext): Promise<void> {
  const key = `custom-${context.runId}`;
  const refused = await context.account
    .createSandbox({
      name: key,
      config: {
        provider: "custom",
        network: { mode: "allow-all" },
        options: { endpoint: "https://10.0.0.8" },
      },
    })
    .then(
      (): string => "accepted",
      (error: unknown): string => String(error),
    );
  assertStep(
    "a custom sandbox on a private endpoint is refused",
    refused.includes("must not point to a private or internal address"),
    refused,
  );

  const sandbox = await context.account.createSandbox({
    name: key,
    config: {
      provider: "custom",
      network: { mode: "allow-all" },
      options: {
        endpoint: "https://sandbox.example.com",
        headers: { "x-team": "ops" },
      },
    },
  });
  assertStep(
    "a custom sandbox keeps its endpoint and headers",
    sandbox.config.provider === "custom" &&
      sandbox.config.options?.endpoint === "https://sandbox.example.com" &&
      JSON.stringify(sandbox.config.options?.headers) ===
        JSON.stringify({ "x-team": "ops" }),
    JSON.stringify(sandbox),
  );

  // A code sync resolves the ref, so the stored header holds the secret itself.
  const sync = new BroodsSyncClient({
    baseUrl: context.edgeUrl,
    token: context.accountSecret,
  });
  const synced = `${key}-synced`;
  const manifest: CliManifest = {
    version: 1,
    project: key,
    stage: "development",
    resources: [
      {
        kind: "sandbox",
        name: synced,
        config: {
          provider: "custom",
          network: { mode: "allow-all" },
          options: {
            endpoint: "https://sandbox.example.com",
            headers: {
              authorization: { __beeblastEnv: true, name: "SANDBOX_AUTH" },
            },
          },
        },
      },
    ],
  };
  await sync.setEnv(key, "development", "SANDBOX_AUTH", "Bearer sk_verify");
  const result = await context.measure(
    "sync a custom sandbox",
    (): ReturnType<typeof sync.putManifest> => sync.putManifest(manifest, true),
  );
  const sandboxId = result.ids.sandboxes[synced] ?? "";
  const read = await context.account.getSandbox(sandboxId);
  assertStep(
    "a synced custom sandbox's resolved credential header reads back redacted",
    JSON.stringify(read?.config.options?.headers) ===
      JSON.stringify({ authorization: "********" }),
    JSON.stringify(read),
  );
}
