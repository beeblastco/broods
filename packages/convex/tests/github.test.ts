import { blake2b } from "@noble/hashes/blake2.js";
import nacl from "tweetnacl";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  broodsRootsFromPaths,
  commitFiles,
  lastErrorLine,
  deployWorkflow,
  isAgentEditable,
  type GitHubApp,
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
    expect(workflow).toContain(
      "if: github.ref_name == 'main' || github.ref_name == 'dev'",
    );
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
      developmentBranch: "dev",
      environments: false,
    });

    expect(workflow).toContain('branches: ["main", "dev"]');
    expect(workflow).toContain("actions/setup-node@v4");
    expect(workflow).not.toContain("corepack");
    expect(workflow).toContain("npx --yes broods deploy");
    expect(workflow).not.toContain("environment:");
    expect(workflow).toContain(
      "BROODS_TOKEN: ${{ github.ref_name == 'main' && secrets.BROODS_PRODUCTION_TOKEN || secrets.BROODS_DEVELOPMENT_TOKEN }}",
    );
  });

  test("a repo deploying one stage runs it on every mapped push, with no ref test", () => {
    const workflow = deployWorkflow({
      projectSlug: "support",
      baseUrl: "https://gateway.broods.app",
      rootDirectory: "",
      installDirectory: "",
      manager: "bun",
      developmentBranch: "main",
      environments: true,
    });

    expect(workflow).toContain('branches: ["main"]');
    expect(workflow).toContain("environment: ${{ 'broods-development' }}");
    expect(workflow).toContain("BROODS_STAGE: ${{ 'development' }}");
    expect(workflow).toContain("if: github.ref_name == 'main'\n");
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

test("a failed run's reason is its last logged error line, without GitHub's framing", () => {
  const log = [
    "2026-11-04T00:11:50.1000000Z ##[group]Run bunx broods deploy",
    "2026-11-04T00:11:57.2000000Z Error: defineMcp needs a url or a handler",
    "2026-11-04T00:11:57.2100000Z     at compile (broods/deepwiki.ts:3:1)",
    "2026-11-04T00:11:57.3000000Z ##[error]Process completed with exit code 1.",
  ].join("\n");

  expect(lastErrorLine(log)).toBe("Error: defineMcp needs a url or a handler");
  expect(
    lastErrorLine("2026-11-04T00:11:57.3000000Z all good"),
  ).toBeUndefined();
});

describe("agent edits", () => {
  const app: GitHubApp = {
    apiUrl: "https://api.github.test",
    appId: "1",
    clientId: "c",
    clientSecret: "s",
    privateKey: "k",
    slug: "broods",
    webUrl: "https://github.test",
    webhookSecret: "w",
  };
  const files = [{ content: "export {};\n", path: "broods/index.ts" }];

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Answers each GitHub call by method and path; `refuse` fails the direct ref update.
  function stubGitHub(refuse: boolean): string[] {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const path = url.replace(app.apiUrl, "");
      calls.push(`${init.method} ${path}`);
      const json = (body: unknown, status = 200): Response =>
        new Response(JSON.stringify(body), { status: status });
      if (init.method === "PATCH" && refuse && path.endsWith("/heads/dev")) {
        return json({ message: "protected" }, 409);
      }
      if (path.includes("/git/ref/")) return json({ object: { sha: "head" } });
      if (path.includes("/git/commits/")) return json({ tree: { sha: "t0" } });
      if (path.endsWith("/git/trees")) return json({ sha: "t1" });
      if (path.endsWith("/git/commits")) {
        return json({ sha: "c1", html_url: "https://github.test/commit/c1" });
      }
      if (path.endsWith("/pulls")) {
        return json({ html_url: "https://github.test/pull/7" });
      }

      return json({});
    });

    return calls;
  }

  test("a branch that moved since the agent read it refuses before writing anything", async () => {
    const calls = stubGitHub(true);

    await expect(
      commitFiles(app, "t", "o/r", "dev", files, "m", "older"),
    ).rejects.toThrow("dev changed since the agent read it");
    expect(calls.filter((call) => !call.startsWith("GET"))).toEqual([]);
  });

  test("only text files inside broods/ are editable", () => {
    expect(isAgentEditable("broods/", "broods/index.ts")).toBe(true);
    expect(isAgentEditable("apps/web/broods/", "apps/web/broods/a/b.md")).toBe(
      true,
    );
    expect(isAgentEditable("broods/", "package.json")).toBe(false);
    expect(isAgentEditable("broods/", "broods/../package.json")).toBe(false);
    expect(isAgentEditable("broods/", "broods/_generated/api.ts")).toBe(false);
    expect(isAgentEditable("broods/", "broods/.env.local")).toBe(false);
    expect(isAgentEditable("broods/", "broods/logo.png")).toBe(false);
    expect(isAgentEditable("broods/", "broods/dist/index.js")).toBe(false);
    expect(isAgentEditable("broods/", "broods/node_modules/x/a.ts")).toBe(
      false,
    );
  });

  test("a change lands as one commit on the branch", async () => {
    const calls = stubGitHub(false);

    const result = await commitFiles(
      app,
      "t",
      "o/r",
      "dev",
      files,
      "m",
      "head",
    );

    expect(result).toEqual({
      sha: "c1",
      url: "https://github.test/commit/c1",
      viaPullRequest: false,
    });
    expect(calls.filter((call) => call.startsWith("POST"))).toEqual([
      "POST /repos/o/r/git/trees",
      "POST /repos/o/r/git/commits",
    ]);
    expect(calls).toContain("PATCH /repos/o/r/git/refs/heads/dev");
  });

  test("a null content deletes the file in the same commit", async () => {
    stubGitHub(false);
    const answer = globalThis.fetch;
    let tree: unknown;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (url.endsWith("/git/trees") && typeof init.body === "string") {
        tree = JSON.parse(init.body).tree;
      }

      return await answer(url, init);
    });

    await commitFiles(
      app,
      "t",
      "o/r",
      "dev",
      [...files, { content: null, path: "broods/old.ts" }],
      "m",
      "head",
    );

    expect(tree).toEqual([
      {
        path: "broods/index.ts",
        mode: "100644",
        type: "blob",
        content: "export {};\n",
      },
      { path: "broods/old.ts", mode: "100644", type: "blob", sha: null },
    ]);
  });

  test("a branch that refuses the write gets a pull request instead", async () => {
    const calls = stubGitHub(true);

    const result = await commitFiles(
      app,
      "t",
      "o/r",
      "dev",
      files,
      "m",
      "head",
    );

    expect(result).toEqual({
      sha: "c1",
      url: "https://github.test/pull/7",
      viaPullRequest: true,
    });
    expect(calls.at(-1)).toBe("POST /repos/o/r/pulls");
  });
});
