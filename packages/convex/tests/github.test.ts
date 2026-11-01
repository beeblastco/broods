import { blake2b } from "@noble/hashes/blake2b";
import nacl from "tweetnacl";
import { describe, expect, test } from "vitest";

import {
  broodsRootsFromPaths,
  deployWorkflow,
  sealSecret,
  verifyWebhookSignature,
} from "../model/github";

describe("broodsRootsFromPaths", () => {
  test("finds each broods/ folder with the lockfile nearest above it", () => {
    expect(
      broodsRootsFromPaths([
        "bun.lock",
        "apps/web/broods/index.ts",
        "apps/web/broods/_generated/api.ts",
        "apps/web/broods/types.d.ts",
        "services/agents/pnpm-lock.yaml",
        "services/agents/broods/support.ts",
        "node_modules/pkg/broods/index.ts",
        "docs/broods/guide.md",
        "deep/broods/nested/agent.ts",
      ]),
    ).toEqual([
      { rootDirectory: "apps/web", installDirectory: "", manager: "bun" },
      {
        rootDirectory: "services/agents",
        installDirectory: "services/agents",
        manager: "pnpm",
      },
    ]);
  });

  test("a repo-root broods/ with no lockfile installs with npm at the root", () => {
    expect(broodsRootsFromPaths(["broods/index.ts"])).toEqual([
      { rootDirectory: "", installDirectory: "", manager: "npm" },
    ]);
  });
});

describe("deployWorkflow", () => {
  test("maps the production branch to Production and the other to Development", () => {
    const workflow = deployWorkflow({
      projectSlug: "support",
      baseUrl: "https://gateway.broods.app",
      rootDirectory: "apps/web",
      installDirectory: "",
      manager: "bun",
      productionBranch: "main",
      developmentBranch: "dev",
      environments: true,
    });

    expect(workflow).toContain('branches: ["main", "dev"]');
    expect(workflow).toContain("oven-sh/setup-bun@v2");
    expect(workflow).toContain('working-directory: "."');
    expect(workflow).toContain('working-directory: "apps/web"');
    expect(workflow).toContain(
      'bunx broods deploy --stage "$BROODS_STAGE" --prune',
    );
    expect(workflow).toContain(
      "BROODS_STAGE: ${{ github.ref_name == 'main' && 'production' || 'development' }}",
    );
    expect(workflow).toContain(
      "environment: ${{ github.ref_name == 'main' && 'broods-production' || 'broods-development' }}",
    );
    expect(workflow).toContain("BROODS_TOKEN: ${{ secrets.BROODS_TOKEN }}");
  });

  test("an npm repo without environments sets up node and reads repo secrets", () => {
    const workflow = deployWorkflow({
      projectSlug: "support",
      baseUrl: "https://gateway.broods.app",
      rootDirectory: "",
      installDirectory: "",
      manager: "npm",
      productionBranch: "main",
      environments: false,
    });

    expect(workflow).toContain('branches: ["main"]');
    expect(workflow).toContain("actions/setup-node@v4");
    expect(workflow).not.toContain("corepack");
    expect(workflow).toContain("npx --yes broods deploy");
    expect(workflow).not.toContain("environment:");
    expect(workflow).toContain(
      "BROODS_TOKEN: ${{ github.ref_name == 'main' && secrets.BROODS_PRODUCTION_TOKEN || secrets.BROODS_DEVELOPMENT_TOKEN }}",
    );
  });
});

test("sealSecret opens with the repo's private key, as libsodium's sealed box does", () => {
  const repo = nacl.box.keyPair();
  const sealed = Uint8Array.from(
    atob(sealSecret(btoa(String.fromCharCode(...repo.publicKey)), "bpdk_x")),
    (char) => char.charCodeAt(0),
  );
  const ephemeral = sealed.slice(0, 32);
  const nonce = blake2b(new Uint8Array([...ephemeral, ...repo.publicKey]), {
    dkLen: 24,
  });
  const opened = nacl.box.open(
    sealed.slice(32),
    nonce,
    ephemeral,
    repo.secretKey,
  );

  expect(opened && new TextDecoder().decode(opened)).toBe("bpdk_x");
});

test("verifyWebhookSignature accepts only the secret's HMAC", async () => {
  const body = '{"action":"completed"}';
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("secret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
  );
  const signature = `sha256=${Array.from(mac, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;

  expect(await verifyWebhookSignature("secret", body, signature)).toBe(true);
  expect(await verifyWebhookSignature("other", body, signature)).toBe(false);
  expect(await verifyWebhookSignature("secret", body, null)).toBe(false);
});
