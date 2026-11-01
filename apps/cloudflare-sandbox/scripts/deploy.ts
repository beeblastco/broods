import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REGISTRY = "registry.cloudflare.com";
const REPOSITORY = "broods-sandbox";

interface BridgeConfig {
  name: string;
  containers: [
    { images: Record<string, { dockerfile?: string; image?: string }> },
  ];
}

const worker = required("WORKER_NAME");
const account = required("CLOUDFLARE_ACCOUNT_ID");
const dockerfile = await Bun.file("Dockerfile").text();
const tag = new Bun.CryptoHasher("sha256")
  .update(dockerfile)
  .digest("hex")
  .slice(0, 16);
const digest = (await imageDigest()) ?? (await buildImage());
// A per-stage copy: wrangler names the Container app after `name`, not --name (workers-sdk#15827).
const config: BridgeConfig = require("../wrangler.jsonc");
config.name = worker;
config.containers[0].images.sandbox = {
  image: `${REGISTRY}/${account}/${REPOSITORY}@${digest}`,
};
await Bun.write("wrangler.deploy.json", JSON.stringify(config));
await $`wrangler deploy --config wrangler.deploy.json`;

// The Dockerfile copies nothing in, so it alone is the build context.
async function buildImage(): Promise<string> {
  const context = await mkdtemp(join(tmpdir(), "broods-sandbox-"));
  try {
    await Bun.write(join(context, "Dockerfile"), dockerfile);
    await $`wrangler containers build ${context} -t ${REPOSITORY}:${tag} -p`;
  } finally {
    await rm(context, { recursive: true, force: true });
  }
  const pushed = await imageDigest();
  if (!pushed)
    throw new Error(`${REPOSITORY}:${tag} is missing after the push`);

  return pushed;
}

async function imageDigest(): Promise<string | undefined> {
  const image = `${REPOSITORY}:${tag}`;
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
  const digest = response.headers.get("Docker-Content-Digest");
  if (!response.ok || !digest)
    throw new Error(
      `${REGISTRY} answered ${response.status} for ${image} with no digest`,
    );

  return digest;
}

async function registryPassword(): Promise<string> {
  const credentials: { password: string } =
    await $`wrangler containers registries credentials ${REGISTRY} --pull --json`.json();

  return credentials.password;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);

  return value;
}
