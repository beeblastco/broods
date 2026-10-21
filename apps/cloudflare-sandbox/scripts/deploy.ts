/**
 * Deploys the bridge as `$WORKER_NAME`, run by `bun run deploy` from
 * `sst deploy`. The Container image is built only when the Dockerfile changes:
 * it lives in the registry as `broods-sandbox:<Dockerfile hash>`, shared by
 * every stage, and the deploy points at its digest, so a code-only deploy does
 * no Docker work. The config is a copy named for the stage, because wrangler
 * names the Container application after `name`, not `--name` (workers-sdk#15827).
 */
import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APP = new URL("..", import.meta.url).pathname;
const REGISTRY = "registry.cloudflare.com";
const REPOSITORY = "broods-sandbox";

/** The fields of wrangler.jsonc this script rewrites. */
interface BridgeConfig {
  name: string;
  containers: [
    { images: Record<string, { dockerfile?: string; image?: string }> },
  ];
}

const worker = required("WORKER_NAME");
const account = required("CLOUDFLARE_ACCOUNT_ID");
const dockerfile = await Bun.file(join(APP, "Dockerfile")).text();
const tag = new Bun.CryptoHasher("sha256")
  .update(dockerfile)
  .digest("hex")
  .slice(0, 16);
const digest = (await imageDigest()) ?? (await buildImage());
const config: BridgeConfig = require(join(APP, "wrangler.jsonc"));
config.name = worker;
config.containers[0].images.sandbox = {
  image: `${REGISTRY}/${account}/${REPOSITORY}@${digest}`,
};
await Bun.write(join(APP, "wrangler.deploy.json"), JSON.stringify(config));
await $`wrangler deploy --config wrangler.deploy.json`.cwd(APP);

// Builds and pushes the Dockerfile alone (it copies nothing in, so it is the
// whole build context), then returns the pushed image's digest.
async function buildImage(): Promise<string> {
  const context = await mkdtemp(join(tmpdir(), "broods-sandbox-"));
  try {
    await Bun.write(join(context, "Dockerfile"), dockerfile);
    await $`wrangler containers build ${context} -t ${REPOSITORY}:${tag} -p`.cwd(
      APP,
    );
  } finally {
    await rm(context, { recursive: true, force: true });
  }
  const pushed = await imageDigest();
  if (!pushed)
    throw new Error(`${REPOSITORY}:${tag} is missing after the push`);

  return pushed;
}

// The digest the registry holds for this Dockerfile's tag, or undefined when it
// has none. A HEAD needs no Docker, the way wrangler reads digests itself.
async function imageDigest(): Promise<string | undefined> {
  const response = await fetch(
    `https://${REGISTRY}/v2/${account}/${REPOSITORY}/manifests/${tag}`,
    {
      method: "HEAD",
      headers: {
        Authorization: `Basic ${btoa(`v1:${await registryPassword()}`)}`,
        Accept:
          "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
      },
    },
  );
  if (response.status === 404) return undefined;
  if (!response.ok)
    throw new Error(
      `${REGISTRY} answered ${response.status} for ${REPOSITORY}:${tag}`,
    );

  return response.headers.get("Docker-Content-Digest") ?? undefined;
}

// A short-lived pull password for the account's registry.
async function registryPassword(): Promise<string> {
  const credentials: { password: string } =
    await $`wrangler containers registries credentials ${REGISTRY} --pull --json`
      .cwd(APP)
      .json();

  return credentials.password;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);

  return value;
}
