/**
 * The GitHub half of a linked repo, run by the config plane: the Broods
 * GitHub App's credentials, its REST calls, the deploy workflow Broods commits
 * and the sealed repo secrets it deploys with. A push runs that workflow in
 * the user's own Actions, which calls `broods deploy`, so Broods builds
 * nothing. Plain fetch and Web Crypto, so it runs in Convex.
 */

import { blake2b } from "@noble/hashes/blake2b";
import nacl from "tweetnacl";

import { ClientError } from "./clientError";

export const WORKFLOW_PATH = ".github/workflows/broods.yml";
export const WORKFLOW_NAME = "Broods deploy";

/**
 * The GitHub Environments holding each stage's project key as `BROODS_TOKEN`,
 * each open only to its own branch, so a pushed branch cannot read Production's.
 */
export const DEPLOY_ENVIRONMENTS = {
  production: "broods-production",
  development: "broods-development",
} as const;

/** Repo-level secrets, the fallback where the plan has no environments on a private repo. */
export const DEPLOY_TOKEN_SECRETS = {
  production: "BROODS_PRODUCTION_TOKEN",
  development: "BROODS_DEVELOPMENT_TOKEN",
} as const;

const ENVIRONMENT_SECRET = "BROODS_TOKEN";

const GITHUB_TIMEOUT_MS = 15_000;
const SETUP_BRANCH = "broods/deploy-workflow";
const REPO_LIST_MAX_PAGES = 10;

const INSTALL: Record<PackageManager, string> = {
  bun: "bun install --frozen-lockfile",
  npm: "npm install",
  pnpm: "pnpm install --frozen-lockfile",
  yarn: "yarn install --frozen-lockfile",
};

// npx finds a local `broods` bin and fetches one when the repo has none.
const RUN: Record<PackageManager, string> = {
  bun: "bunx",
  npm: "npx --yes",
  pnpm: "npx --yes",
  yarn: "npx --yes",
};

/** Lockfiles in the order a monorepo's own beats a stray one. */
const LOCKFILES: ReadonlyArray<{ file: string; manager: PackageManager }> = [
  { file: "bun.lock", manager: "bun" },
  { file: "bun.lockb", manager: "bun" },
  { file: "pnpm-lock.yaml", manager: "pnpm" },
  { file: "yarn.lock", manager: "yarn" },
  { file: "package-lock.json", manager: "npm" },
];

export type PackageManager = "bun" | "npm" | "pnpm" | "yarn";

/** The Broods GitHub App this deployment runs as, from its environment. */
export interface GitHubApp {
  appId: string;
  slug: string;
  privateKey: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  /** REST API root, `https://api.github.com` unless GitHub is faked. */
  apiUrl: string;
  /** Web root for the install and sign-in pages, `https://github.com`. */
  webUrl: string;
}

/** A repo the App can reach, as the import list shows it. */
export interface GitHubRepo {
  installationId: number;
  repoId: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
}

/** Where `broods/` sits in a repo and how its dependencies install. */
export interface BroodsRoot {
  /** The folder holding `broods/`; "" is the repo root. */
  rootDirectory: string;
  /** The folder with the lockfile, the repo root for most monorepos. */
  installDirectory: string;
  manager: PackageManager;
}

/** What the workflow needs to know about the project it deploys. */
export interface WorkflowTarget extends BroodsRoot {
  projectSlug: string;
  baseUrl: string;
  productionBranch: string;
  developmentBranch?: string;
  /** Keys sit in the per-branch environments, not repo secrets. */
  environments: boolean;
}

/** Each stage's branch and project key. */
export interface DeployKeys {
  production: { branch: string; token: string };
  development: { branch: string; token: string };
}

/** A user's GitHub installation, from `GET /user/installations`. */
export interface UserInstallation {
  installationId: number;
  login: string;
  accountType: "User" | "Organization";
}

/** A non-2xx GitHub answer; `status` lets callers tell a protected branch from a bug. */
export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface RawRepo {
  id: number;
  full_name: string;
  private: boolean;
  default_branch: string;
}

interface RawInstallation {
  id: number;
  account: { login: string; type: string } | null;
}

/** The App's configuration, or null when this deployment has no GitHub App. */
export function githubApp(): GitHubApp | null {
  const appId = process.env.GITHUB_APP_ID;
  const slug = process.env.GITHUB_APP_SLUG;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  const clientId = process.env.GITHUB_APP_CLIENT_ID;
  const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET;
  const webhookSecret = process.env.GITHUB_APP_WEBHOOK_SECRET;
  if (
    !appId ||
    !slug ||
    !privateKey ||
    !clientId ||
    !clientSecret ||
    !webhookSecret
  ) {
    return null;
  }

  return {
    appId: appId,
    slug: slug,
    // A multi-line PEM often arrives with its newlines escaped.
    privateKey: privateKey.replace(/\\n/g, "\n"),
    clientId: clientId,
    clientSecret: clientSecret,
    webhookSecret: webhookSecret,
    apiUrl: trimSlash(process.env.GITHUB_API_URL ?? "https://api.github.com"),
    webUrl: trimSlash(process.env.GITHUB_WEB_URL ?? "https://github.com"),
  };
}

/** `githubApp()`, or a ClientError the dashboard can show. */
export function requireGitHubApp(): GitHubApp {
  const app = githubApp();
  if (!app) {
    throw new ClientError("GitHub is not set up on this Broods deployment.");
  }

  return app;
}

/** The App's install page; GitHub returns to the callback with `state`. */
export function installUrl(app: GitHubApp, state: string): string {
  return `${app.webUrl}/apps/${app.slug}/installations/new?state=${encodeURIComponent(state)}`;
}

/** The App's sign-in page, for a round trip that only needs the user's token. */
export function authorizeUrl(app: GitHubApp, state: string): string {
  const query = new URLSearchParams({ client_id: app.clientId, state: state });

  return `${app.webUrl}/login/oauth/authorize?${query.toString()}`;
}

/** Trades a callback's code for the user's token. Used once, never stored. */
export async function exchangeUserCode(
  app: GitHubApp,
  code: string,
): Promise<string> {
  const response = await fetch(`${app.webUrl}/login/oauth/access_token`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      code: code,
    }),
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    error_description?: string;
  };
  if (!response.ok || !body.access_token) {
    throw new ClientError(
      `GitHub sign-in failed: ${body.error_description ?? `HTTP ${response.status}`}`,
    );
  }

  return body.access_token;
}

/** The installations the signed-in GitHub user can reach. */
export async function listUserInstallations(
  app: GitHubApp,
  userToken: string,
): Promise<UserInstallation[]> {
  const body = await githubRequest<{ installations: RawInstallation[] }>(
    app,
    userToken,
    "GET",
    "/user/installations?per_page=100",
  );

  return body.installations.flatMap((installation) =>
    installation.account
      ? [
          {
            installationId: installation.id,
            login: installation.account.login,
            accountType:
              installation.account.type === "Organization"
                ? ("Organization" as const)
                : ("User" as const),
          },
        ]
      : [],
  );
}

/** A short-lived token that acts as the App on one installation. */
export async function installationToken(
  app: GitHubApp,
  installationId: number,
): Promise<string> {
  const body = await githubRequest<{ token: string }>(
    app,
    await appJwt(app),
    "POST",
    `/app/installations/${installationId}/access_tokens`,
  );

  return body.token;
}

/** Every repo one installation can reach. */
export async function listInstallationRepos(
  app: GitHubApp,
  installationId: number,
): Promise<GitHubRepo[]> {
  const token = await installationToken(app, installationId);
  const repos: GitHubRepo[] = [];
  for (let page = 1; page <= REPO_LIST_MAX_PAGES; page += 1) {
    const body = await githubRequest<{
      total_count: number;
      repositories: RawRepo[];
    }>(
      app,
      token,
      "GET",
      `/installation/repositories?per_page=100&page=${page}`,
    );
    repos.push(
      ...body.repositories.map((repo) => toRepo(installationId, repo)),
    );
    if (repos.length >= body.total_count || body.repositories.length === 0) {
      break;
    }
  }

  return repos;
}

/** One repo by id, through the installation that reaches it. */
export async function getRepo(
  app: GitHubApp,
  token: string,
  installationId: number,
  repoId: number,
): Promise<GitHubRepo> {
  const repo = await githubRequest<RawRepo>(
    app,
    token,
    "GET",
    `/repositories/${repoId}`,
  );

  return toRepo(installationId, repo);
}

/** Every folder in the repo that holds a `broods/` project, at `branch`. */
export async function findBroodsRoots(
  app: GitHubApp,
  token: string,
  fullName: string,
  branch: string,
): Promise<BroodsRoot[]> {
  const body = await githubRequest<{
    tree: Array<{ path: string; type: string }>;
  }>(
    app,
    token,
    "GET",
    `/repos/${fullName}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
  );

  return broodsRootsFromPaths(
    body.tree.filter((entry) => entry.type === "blob").map((e) => e.path),
  );
}

/**
 * The `broods/` folders in a list of repo file paths, each with the lockfile
 * nearest above it. A folder counts when it holds a `.ts` file outside
 * `_generated`; dependencies never count.
 */
export function broodsRootsFromPaths(paths: readonly string[]): BroodsRoot[] {
  const files = new Set(paths);
  const roots = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    if (parts.includes("node_modules")) continue;
    const at = parts.lastIndexOf("broods");
    // `broods/<file>.ts` directly: the CLI reads that folder, not deeper.
    if (at < 0 || at !== parts.length - 2) continue;
    if (!path.endsWith(".ts") || path.endsWith(".d.ts")) continue;
    roots.add(parts.slice(0, at).join("/"));
  }

  return [...roots].sort().map((rootDirectory) => ({
    rootDirectory: rootDirectory,
    ...installFor(files, rootDirectory),
  }));
}

/** The workflow Broods commits: a push to a mapped branch deploys its stage. */
export function deployWorkflow(target: WorkflowTarget): string {
  const branches = [target.productionBranch, target.developmentBranch].filter(
    (branch): branch is string => Boolean(branch),
  );
  const isProduction = `github.ref_name == '${target.productionBranch}'`;
  const setup =
    target.manager === "bun"
      ? ["      - uses: oven-sh/setup-bun@v2"]
      : [
          "      - uses: actions/setup-node@v4",
          "        with:",
          "          node-version: 22",
          ...(target.manager === "npm" ? [] : ["      - run: corepack enable"]),
        ];

  return [
    "# Written by Broods. A push to a mapped branch deploys broods/ to its stage.",
    "# Edit freely; unlinking the repo in Broods leaves this file alone.",
    `name: ${WORKFLOW_NAME}`,
    "on:",
    "  push:",
    `    branches: [${branches.map(quote).join(", ")}]`,
    "  workflow_dispatch:",
    "concurrency:",
    "  group: broods-deploy-${{ github.ref_name }}",
    "  cancel-in-progress: false",
    "jobs:",
    "  deploy:",
    "    runs-on: ubuntu-latest",
    ...(target.environments
      ? [
          `    environment: \${{ ${isProduction} && '${DEPLOY_ENVIRONMENTS.production}' || '${DEPLOY_ENVIRONMENTS.development}' }}`,
        ]
      : []),
    "    steps:",
    "      - uses: actions/checkout@v4",
    ...setup,
    `      - run: ${INSTALL[target.manager]}`,
    `        working-directory: ${quote(target.installDirectory || ".")}`,
    `      - run: ${RUN[target.manager]} broods deploy --stage "$BROODS_STAGE" --prune`,
    `        working-directory: ${quote(target.rootDirectory || ".")}`,
    "        env:",
    `          BROODS_BASE_URL: ${quote(target.baseUrl)}`,
    `          BROODS_PROJECT: ${quote(target.projectSlug)}`,
    `          BROODS_STAGE: \${{ ${isProduction} && 'production' || 'development' }}`,
    target.environments
      ? `          BROODS_TOKEN: \${{ secrets.${ENVIRONMENT_SECRET} }}`
      : `          BROODS_TOKEN: \${{ ${isProduction} && secrets.${DEPLOY_TOKEN_SECRETS.production} || secrets.${DEPLOY_TOKEN_SECRETS.development} }}`,
    "",
  ].join("\n");
}

/**
 * Writes the workflow to `branch`, or opens a PR with it when the branch
 * refuses a direct commit. Answers the PR's URL, or undefined when the file
 * landed or was already current.
 */
export async function commitWorkflow(
  app: GitHubApp,
  token: string,
  fullName: string,
  branch: string,
  workflow: string,
): Promise<string | undefined> {
  const message = "ci: deploy broods/ on push";
  try {
    await putFile(
      app,
      token,
      fullName,
      branch,
      WORKFLOW_PATH,
      workflow,
      message,
    );

    return undefined;
  } catch (error) {
    if (!(error instanceof GitHubApiError) || !isRefusedWrite(error.status)) {
      throw error;
    }
  }
  const head = await githubRequest<{ object: { sha: string } }>(
    app,
    token,
    "GET",
    `/repos/${fullName}/git/ref/heads/${encodeURIComponent(branch)}`,
  );
  await githubRequest(app, token, "POST", `/repos/${fullName}/git/refs`, {
    ref: `refs/heads/${SETUP_BRANCH}`,
    sha: head.object.sha,
  }).catch(ignoreStatus(422));
  await putFile(
    app,
    token,
    fullName,
    SETUP_BRANCH,
    WORKFLOW_PATH,
    workflow,
    message,
  );
  const owner = fullName.split("/")[0] ?? "";
  const open = await githubRequest<Array<{ html_url: string }>>(
    app,
    token,
    "GET",
    `/repos/${fullName}/pulls?state=open&base=${encodeURIComponent(branch)}&head=${encodeURIComponent(`${owner}:${SETUP_BRANCH}`)}`,
  );
  if (open[0]) return open[0].html_url;
  const pull = await githubRequest<{ html_url: string }>(
    app,
    token,
    "POST",
    `/repos/${fullName}/pulls`,
    {
      title: "Deploy broods/ on push",
      head: SETUP_BRANCH,
      base: branch,
      body: `${branch} is protected, so Broods could not commit \`${WORKFLOW_PATH}\` directly. Merge this to deploy on every push.`,
    },
  );

  return pull.html_url;
}

/** Whether `branch` exists in the repo. */
export async function branchExists(
  app: GitHubApp,
  token: string,
  fullName: string,
  branch: string,
): Promise<boolean> {
  try {
    await githubRequest(
      app,
      token,
      "GET",
      `/repos/${fullName}/branches/${encodeURIComponent(branch)}`,
    );

    return true;
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) return false;
    throw error;
  }
}

/**
 * Seals each stage's key into an environment only its branch may deploy
 * from, and answers true. A plan without environments on a private repo
 * refuses them; the keys then go in as repo secrets and this answers false.
 */
export async function sealDeployKeys(
  app: GitHubApp,
  token: string,
  fullName: string,
  keys: DeployKeys,
): Promise<boolean> {
  try {
    for (const stage of ["production", "development"] as const) {
      const environment = `/repos/${fullName}/environments/${DEPLOY_ENVIRONMENTS[stage]}`;
      await githubRequest(app, token, "PUT", environment, {
        deployment_branch_policy: {
          protected_branches: false,
          custom_branch_policies: true,
        },
      });
      await githubRequest(
        app,
        token,
        "POST",
        `${environment}/deployment-branch-policies`,
        { name: keys[stage].branch, type: "branch" },
      ).catch(ignoreStatus(409));
      await setSecret(
        app,
        token,
        `${environment}/secrets`,
        ENVIRONMENT_SECRET,
        keys[stage].token,
      );
    }

    return true;
  } catch (error) {
    if (
      !(error instanceof GitHubApiError) ||
      !(isRefusedWrite(error.status) || error.status === 404)
    ) {
      throw error;
    }
  }
  for (const stage of ["production", "development"] as const) {
    await setSecret(
      app,
      token,
      `/repos/${fullName}/actions/secrets`,
      DEPLOY_TOKEN_SECRETS[stage],
      keys[stage].token,
    );
  }

  return false;
}

/**
 * Creates `owner/name` with the user's token and lets the installation reach
 * it. `prepare` then runs (sealing the keys, so the first push finds them)
 * and answers the files to commit on the default branch, with
 * `developmentBranch` cut from that commit.
 */
export async function createRepo(
  app: GitHubApp,
  userToken: string,
  installation: UserInstallation,
  repo: { name: string; private: boolean },
  prepare: (created: GitHubRepo) => Promise<Record<string, string>>,
  developmentBranch: string,
): Promise<GitHubRepo> {
  const path =
    installation.accountType === "Organization"
      ? `/orgs/${installation.login}/repos`
      : "/user/repos";
  const created = await githubRequest<RawRepo>(app, userToken, "POST", path, {
    name: repo.name,
    private: repo.private,
    auto_init: true,
  });
  // An install on selected repos does not reach a new one until it is added.
  await githubRequest(
    app,
    userToken,
    "PUT",
    `/user/installations/${installation.installationId}/repositories/${created.id}`,
  );
  const files = await prepare(toRepo(installation.installationId, created));
  const token = await installationToken(app, installation.installationId);
  const fullName = created.full_name;
  const branch = created.default_branch;
  const head = await githubRequest<{ object: { sha: string } }>(
    app,
    token,
    "GET",
    `/repos/${fullName}/git/ref/heads/${encodeURIComponent(branch)}`,
  );
  const parent = await githubRequest<{ tree: { sha: string } }>(
    app,
    token,
    "GET",
    `/repos/${fullName}/git/commits/${head.object.sha}`,
  );
  const tree = await githubRequest<{ sha: string }>(
    app,
    token,
    "POST",
    `/repos/${fullName}/git/trees`,
    {
      base_tree: parent.tree.sha,
      tree: Object.entries(files).map(([path, content]) => ({
        path: path,
        mode: "100644",
        type: "blob",
        content: content,
      })),
    },
  );
  const commit = await githubRequest<{ sha: string }>(
    app,
    token,
    "POST",
    `/repos/${fullName}/git/commits`,
    {
      message: "feat: start a Broods project",
      tree: tree.sha,
      parents: [head.object.sha],
    },
  );
  await githubRequest(
    app,
    token,
    "PATCH",
    `/repos/${fullName}/git/refs/heads/${encodeURIComponent(branch)}`,
    { sha: commit.sha },
  );
  await githubRequest(app, token, "POST", `/repos/${fullName}/git/refs`, {
    ref: `refs/heads/${developmentBranch}`,
    sha: commit.sha,
  });

  return toRepo(installation.installationId, created);
}

/** The files a new repo starts with: a `broods/` project that deploys green. */
export function starterFiles(projectSlug: string): Record<string, string> {
  return {
    ".gitignore": "node_modules\n.env.local\n",
    "package.json": `${JSON.stringify(
      {
        name: projectSlug,
        private: true,
        type: "module",
        devDependencies: { broods: "latest" },
      },
      null,
      2,
    )}\n`,
    "broods/.gitignore": "_generated\n.cache\n",
    "broods/index.ts":
      "// Define agents, sandboxes and workspaces here; a push deploys them.\n" +
      "// https://docs.broods.app/guides/deploying\n" +
      "export {};\n",
  };
}

/** Checks `X-Hub-Signature-256` against the App's webhook secret. */
export async function verifyWebhookSignature(
  secret: string,
  body: string,
  signature: string | null,
): Promise<boolean> {
  if (!signature?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  const expected = `sha256=${hex(new Uint8Array(mac))}`;
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) {
    diff |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
  }

  return diff === 0;
}

/**
 * libsodium's `crypto_box_seal`, the encryption GitHub requires for Actions
 * secrets: an ephemeral X25519 key, a nonce of BLAKE2b(epk || pk), and the
 * ephemeral public key in front of the box.
 */
export function sealSecret(publicKeyBase64: string, value: string): string {
  const publicKey = fromBase64(publicKeyBase64);
  const ephemeral = nacl.box.keyPair();
  const nonce = blake2b(concat(ephemeral.publicKey, publicKey), { dkLen: 24 });
  const box = nacl.box(
    new TextEncoder().encode(value),
    nonce,
    publicKey,
    ephemeral.secretKey,
  );

  return toBase64(concat(ephemeral.publicKey, box));
}

/** A GitHub REST call; any non-2xx throws GitHubApiError. */
export async function githubRequest<T = unknown>(
  app: GitHubApp,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${app.apiUrl}${path}`, {
    method: method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "broods",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    const message = (() => {
      try {
        return (JSON.parse(text) as { message?: string }).message;
      } catch {
        return undefined;
      }
    })();
    throw new GitHubApiError(
      response.status,
      `GitHub ${method} ${path.split("?")[0]} failed: ${message ?? `HTTP ${response.status}`}`,
    );
  }

  return (text ? JSON.parse(text) : null) as T;
}

/**
 * An RS256 JWT that authenticates as the App itself, valid ten minutes.
 * GitHub hands out PKCS#1 keys, which Web Crypto only imports as PKCS#8.
 */
async function appJwt(app: GitHubApp): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object): string =>
    base64Url(new TextEncoder().encode(JSON.stringify(value)));
  const signingInput = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iat: now - 60,
    exp: now + 540,
    iss: app.appId,
  })}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8FromPem(app.privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

function base64Url(bytes: Uint8Array): string {
  return toBase64(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left);
  joined.set(right, left.length);

  return joined;
}

// DER: one byte below 128, else 0x80 | byte count, then the bytes.
function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);

  return [0x80 | bytes.length, ...bytes];
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

/** Its body when the file at `path` on `branch` exists, with the blob sha an update needs. */
async function getFile(
  app: GitHubApp,
  token: string,
  fullName: string,
  branch: string,
  path: string,
): Promise<{ sha: string; content: string } | null> {
  try {
    const file = await githubRequest<{ sha: string; content: string }>(
      app,
      token,
      "GET",
      `/repos/${fullName}/contents/${path}?ref=${encodeURIComponent(branch)}`,
    );

    return {
      sha: file.sha,
      content: new TextDecoder().decode(
        fromBase64(file.content.replace(/\s/g, "")),
      ),
    };
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) return null;
    throw error;
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function ignoreStatus(status: number): (error: unknown) => void {
  return (error: unknown): void => {
    if (error instanceof GitHubApiError && error.status === status) return;
    throw error;
  };
}

// The lockfile nearest above `root`, walking up to the repo root; npm when none.
function installFor(
  files: ReadonlySet<string>,
  root: string,
): Omit<BroodsRoot, "rootDirectory"> {
  const parts = root ? root.split("/") : [];
  for (let depth = parts.length; depth >= 0; depth -= 1) {
    const directory = parts.slice(0, depth).join("/");
    const prefix = directory ? `${directory}/` : "";
    const lock = LOCKFILES.find(({ file }) => files.has(`${prefix}${file}`));
    if (lock) return { installDirectory: directory, manager: lock.manager };
  }

  return { installDirectory: root, manager: "npm" };
}

// A branch rule or protection refuses a direct commit with one of these.
function isRefusedWrite(status: number): boolean {
  return status === 403 || status === 409 || status === 422;
}

// PKCS#8 wraps the PKCS#1 key: version 0, the rsaEncryption algorithm, then the key as an octet string.
function pkcs8FromPem(pem: string): ArrayBuffer {
  const der = fromBase64(
    pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, "").replace(/\s/g, ""),
  );
  if (pem.includes("BEGIN PRIVATE KEY")) return der.slice().buffer;
  const algorithm = [
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
    0x01, 0x05, 0x00,
  ];
  const octets = [0x04, ...derLength(der.length)];
  const body = [0x02, 0x01, 0x00, ...algorithm, ...octets];
  const sequence = [0x30, ...derLength(body.length + der.length)];
  const wrapped = new Uint8Array(sequence.length + body.length + der.length);
  wrapped.set(sequence);
  wrapped.set(body, sequence.length);
  wrapped.set(der, sequence.length + body.length);

  return wrapped.buffer;
}

async function putFile(
  app: GitHubApp,
  token: string,
  fullName: string,
  branch: string,
  path: string,
  content: string,
  message: string,
): Promise<void> {
  const existing = await getFile(app, token, fullName, branch, path);
  if (existing?.content === content) return;
  await githubRequest(
    app,
    token,
    "PUT",
    `/repos/${fullName}/contents/${path}`,
    {
      message: message,
      content: toBase64(new TextEncoder().encode(content)),
      branch: branch,
      ...(existing ? { sha: existing.sha } : {}),
    },
  );
}

function quote(value: string): string {
  return JSON.stringify(value);
}

// Seals `value` to the public key under `secrets` (a repo's or an environment's) and stores it.
async function setSecret(
  app: GitHubApp,
  token: string,
  secrets: string,
  name: string,
  value: string,
): Promise<void> {
  const key = await githubRequest<{ key_id: string; key: string }>(
    app,
    token,
    "GET",
    `${secrets}/public-key`,
  );
  await githubRequest(app, token, "PUT", `${secrets}/${name}`, {
    encrypted_value: sealSecret(key.key, value),
    key_id: key.key_id,
  });
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary);
}

function toRepo(installationId: number, repo: RawRepo): GitHubRepo {
  return {
    installationId: installationId,
    repoId: repo.id,
    fullName: repo.full_name,
    private: repo.private,
    defaultBranch: repo.default_branch,
  };
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
