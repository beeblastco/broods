/**
 * The GitHub half of a linked repo: the Broods GitHub App's credentials, its REST calls, the deploy
 * workflow Broods commits and the sealed repo secrets. A push runs that workflow in the user's own
 * Actions (`broods deploy`), so Broods builds nothing. Plain fetch and Web Crypto, for Convex.
 */

import { blake2b } from "@noble/hashes/blake2.js";
import nacl from "tweetnacl";

import { ClientError } from "./clientError";
import { bytesToBase64Url } from "./stageSessionTicket";
import { isSourceFile } from "./stageSource";

export const WORKFLOW_PATH = ".github/workflows/broods.yml";
const WORKFLOW_NAME = "Broods deploy";

/**
 * The GitHub Environments holding each stage's project key as `BROODS_TOKEN`,
 * each open only to its own branch, so a pushed branch cannot read Production's.
 */
const DEPLOY_ENVIRONMENTS = {
  production: "broods-production",
  development: "broods-development",
} as const;

/** Repo-level secrets, the fallback where the plan has no environments on a private repo. */
const DEPLOY_TOKEN_SECRETS = {
  production: "BROODS_PRODUCTION_TOKEN",
  development: "BROODS_DEVELOPMENT_TOKEN",
} as const;

const ENVIRONMENT_SECRET = "BROODS_TOKEN";

const DEVELOPMENT_BRANCHES = ["dev", "development"] as const;

/** The stages a linked repo can deploy, each from its own branch. */
export const STAGES = ["production", "development"] as const;

const GITHUB_TIMEOUT_MS = 15_000;
const LOG_TAIL_CHARS = 20_000;
const ERROR_LINE_CHARS = 300;

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
const AGENT_FILE_LIMIT = 40;
const AGENT_BYTES_LIMIT = 300_000;

export interface RepoFile {
  content: string;
  path: string;
}

/** A file in an agent commit; null `content` deletes it. */
export interface CommitFile {
  content: string | null;
  path: string;
}

const LOCKFILES: ReadonlyArray<{ file: string; manager: PackageManager }> = [
  { file: "bun.lock", manager: "bun" },
  { file: "bun.lockb", manager: "bun" },
  { file: "pnpm-lock.yaml", manager: "pnpm" },
  { file: "yarn.lock", manager: "yarn" },
  { file: "package-lock.json", manager: "npm" },
];

type PackageManager = "bun" | "npm" | "pnpm" | "yarn";

export type Stage = (typeof STAGES)[number];

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
interface BroodsRoot {
  /** The folder holding `broods/`; "" is the repo root. */
  rootDirectory: string;
  /** The folder with the lockfile, the repo root for most monorepos. */
  installDirectory: string;
  manager: PackageManager;
}

/** What the workflow needs to know about the project it deploys. */
interface WorkflowTarget extends BroodsRoot {
  projectSlug: string;
  baseUrl: string;
  /** Each absent one is a stage this repo does not deploy; at least one is set. */
  productionBranch?: string;
  developmentBranch?: string;
  /** Keys sit in the per-branch environments, not repo secrets. */
  environments: boolean;
}

/** The branch and project key of each stage the repo deploys. */
type DeployKeys = Partial<Record<Stage, { branch: string; token: string }>>;

/** A user's GitHub installation, from `GET /user/installations`. */
interface UserInstallation {
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
  const all: RawInstallation[] = [];
  for (let page = 1; ; page += 1) {
    const body = await githubRequest<{ installations: RawInstallation[] }>(
      app,
      userToken,
      "GET",
      `/user/installations?per_page=100&page=${page}`,
    );
    all.push(...body.installations);
    if (body.installations.length < 100) break;
  }

  return all.flatMap((installation) =>
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

/**
 * The installations the signed-in user administers: their own account, or an
 * org they are an admin of. Reaching one repo of an org is not enough, since
 * the App's token for that installation reaches every repo in it.
 */
export async function administeredInstallations(
  app: GitHubApp,
  userToken: string,
  installations: readonly UserInstallation[],
): Promise<UserInstallation[]> {
  const user = await githubRequest<{ login: string }>(
    app,
    userToken,
    "GET",
    "/user",
  );
  const administered = await Promise.all(
    installations.map(async (installation): Promise<boolean> => {
      if (installation.accountType === "User") {
        return installation.login.toLowerCase() === user.login.toLowerCase();
      }
      const membership = await githubRequest<{ role: string; state: string }>(
        app,
        userToken,
        "GET",
        `/user/memberships/orgs/${installation.login}`,
      ).catch((error: unknown) => {
        if (error instanceof GitHubApiError && error.status < 500) return null;
        throw error;
      });

      return membership?.role === "admin" && membership.state === "active";
    }),
  );

  return installations.filter((_installation, index) => administered[index]);
}

/** Development's branch when none is named: `dev`, or `development` where `dev` is the default. */
export function developmentBranchFor(defaultBranch: string): string {
  return (
    DEVELOPMENT_BRANCHES.find((branch) => branch !== defaultBranch) ?? "dev"
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
  // Every page until total_count, so the picker never silently drops a repo.
  for (let page = 1; ; page += 1) {
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

/** The repo's branch names for a picker, up to 1,000 so a huge repo cannot stall the page. */
export async function listBranches(
  app: GitHubApp,
  token: string,
  fullName: string,
): Promise<string[]> {
  const names: string[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const branches = await githubRequest<Array<{ name: string }>>(
      app,
      token,
      "GET",
      `/repos/${fullName}/branches?per_page=100&page=${page}`,
    );
    names.push(...branches.map((branch) => branch.name));
    if (branches.length < 100) break;
  }

  return names;
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
  return broodsRootsFromPaths(await listFiles(app, token, fullName, branch));
}

/** The text files of the `broods/` folder under `rootDirectory`, for the dashboard agent. */
export async function readBroodsFolder(
  app: GitHubApp,
  token: string,
  fullName: string,
  branch: string,
  rootDirectory: string,
): Promise<{ baseSha: string; files: RepoFile[]; omitted: number }> {
  // One snapshot: every read pins the head commit, which Apply later checks has not moved.
  const baseSha = await branchHead(app, token, fullName, branch);
  const prefix = broodsFolder(rootDirectory);
  const paths = (await listFiles(app, token, fullName, baseSha)).filter(
    (path) => isAgentEditable(prefix, path),
  );
  const read = await Promise.all(
    paths
      .slice(0, AGENT_FILE_LIMIT)
      .map((path) => getFile(app, token, fullName, baseSha, path)),
  );
  const files: RepoFile[] = [];
  let bytes = 0;
  read.forEach((file, index) => {
    const path = paths[index];
    if (!file || !path || bytes + file.content.length > AGENT_BYTES_LIMIT) {
      return;
    }
    bytes += file.content.length;
    files.push({ content: file.content, path: path });
  });

  return {
    baseSha: baseSha,
    files: files,
    omitted: paths.length - files.length,
  };
}

/**
 * Commits `files` to `branch` as one commit, or through a pull request from a fresh branch when
 * `viaPullRequest` or the branch refuses a direct write. Answers the commit and the URL to see it.
 */
export async function commitFiles(
  app: GitHubApp,
  token: string,
  fullName: string,
  branch: string,
  files: readonly CommitFile[],
  message: string,
  viaPullRequest: boolean,
  baseSha: string,
): Promise<{ sha: string; url: string; viaPullRequest: boolean }> {
  // Built on the commit the agent read, so a fast-forward update refuses once the branch moved.
  if ((await branchHead(app, token, fullName, branch)) !== baseSha) {
    throw new ClientError(
      `${branch} changed since the agent read it. Ask again so it edits the latest files.`,
    );
  }
  const commit = await commitOn(app, token, fullName, baseSha, files, message);
  if (!viaPullRequest) {
    try {
      await githubRequest(
        app,
        token,
        "PATCH",
        `/repos/${fullName}/git/refs/heads/${encodeURIComponent(branch)}`,
        { sha: commit.sha, force: false },
      );

      return { sha: commit.sha, url: commit.url, viaPullRequest: false };
    } catch (error) {
      if (!(error instanceof GitHubApiError) || !isRefusedWrite(error.status)) {
        throw error;
      }
      if ((await branchHead(app, token, fullName, branch)) !== baseSha) {
        throw new ClientError(
          `${branch} changed since the agent read it. Ask again so it edits the latest files.`,
        );
      }
    }
  }
  const head = `broods/agent-${crypto.randomUUID().slice(0, 8)}`;
  await githubRequest(app, token, "POST", `/repos/${fullName}/git/refs`, {
    ref: `refs/heads/${head}`,
    sha: commit.sha,
  });
  const pull = await githubRequest<{ html_url: string }>(
    app,
    token,
    "POST",
    `/repos/${fullName}/pulls`,
    {
      title: message,
      head: head,
      base: branch,
      body: "Proposed by the Broods agent and applied from the dashboard.",
    },
  );

  return { sha: commit.sha, url: pull.html_url, viaPullRequest: true };
}

/** Why a deploy run failed: the last error its failed job logged, else the step that failed. */
export async function runFailure(
  app: GitHubApp,
  installationId: number,
  fullName: string,
  runId: number,
): Promise<string | undefined> {
  const token = await installationToken(app, installationId);
  const { jobs } = await githubRequest<{
    jobs: Array<{
      conclusion: string | null;
      id: number;
      steps?: Array<{ conclusion: string | null; name: string }>;
    }>;
  }>(app, token, "GET", `/repos/${fullName}/actions/runs/${runId}/jobs`);
  const job = jobs.find((entry) => entry.conclusion === "failure");
  if (!job) return undefined;
  const step = job.steps?.find((entry) => entry.conclusion === "failure");
  // The log is plain text behind a redirect, so it skips githubRequest's JSON parse.
  const log = await fetch(
    `${app.apiUrl}/repos/${fullName}/actions/jobs/${job.id}/logs`,
    {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "broods" },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    },
  );

  return (
    (log.ok ? lastErrorLine(await log.text()) : undefined) ??
    (step ? `${step.name} failed.` : undefined)
  );
}

/** The last error line of a run's log, without GitHub's timestamps or its exit-code line. */
export function lastErrorLine(log: string): string | undefined {
  return log
    .slice(-LOG_TAIL_CHARS)
    .split("\n")
    .map((line) =>
      line
        .replace(/^\S+Z /, "")
        .replace(/^##\[error\]/, "")
        .trim(),
    )
    .findLast(
      (line) =>
        /error/i.test(line) &&
        !line.startsWith("Process completed with exit code"),
    )
    ?.slice(0, ERROR_LINE_CHARS);
}

/** True for a text file inside the `broods/` folder `prefix`, outside build output. */
export function isAgentEditable(prefix: string, path: string): boolean {
  return path.startsWith(prefix) && isSourceFile(path);
}

export function broodsFolder(rootDirectory: string): string {
  return rootDirectory ? `${rootDirectory}/broods/` : "broods/";
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
  const mapped = STAGES.filter((stage) => branchOf(target, stage));
  const branches = mapped.map((stage) => branchOf(target, stage) ?? "");
  // An expression string doubles a single quote, which a branch name may hold.
  const isProduction = `github.ref_name == '${(target.productionBranch ?? "").replace(/'/g, "''")}'`;
  // One stage's value as is; with both, the pushed branch picks.
  const choose = (value: (stage: Stage) => string): string =>
    mapped.length === 1
      ? `\${{ ${value(mapped[0] ?? "development")} }}`
      : `\${{ ${isProduction} && ${value("production")} || ${value("development")} }}`;
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
    // A manual run from any other branch must not deploy a stage.
    `    if: ${branches.map((branch) => `github.ref_name == '${branch.replace(/'/g, "''")}'`).join(" || ")}`,
    "    runs-on: ubuntu-latest",
    ...(target.environments
      ? [
          `    environment: ${choose((stage) => `'${DEPLOY_ENVIRONMENTS[stage]}'`)}`,
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
    `          BROODS_STAGE: ${choose((stage) => `'${stage}'`)}`,
    target.environments
      ? `          BROODS_TOKEN: \${{ secrets.${ENVIRONMENT_SECRET} }}`
      : `          BROODS_TOKEN: ${choose((stage) => `secrets.${DEPLOY_TOKEN_SECRETS[stage]}`)}`,
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
  // One setup branch per target, reset to its base so a PR closed earlier
  // still leaves a commit to open a new one from.
  const setupBranch = `broods/deploy-workflow-${branch}`;
  await createBranch(app, token, fullName, branch, setupBranch, true);
  await putFile(
    app,
    token,
    fullName,
    setupBranch,
    WORKFLOW_PATH,
    workflow,
    message,
  );
  const owner = fullName.split("/")[0] ?? "";
  const open = await githubRequest<Array<{ html_url: string }>>(
    app,
    token,
    "GET",
    `/repos/${fullName}/pulls?state=open&base=${encodeURIComponent(branch)}&head=${encodeURIComponent(`${owner}:${setupBranch}`)}`,
  );
  if (open[0]) return open[0].html_url;
  const pull = await githubRequest<{ html_url: string }>(
    app,
    token,
    "POST",
    `/repos/${fullName}/pulls`,
    {
      title: "Deploy broods/ on push",
      head: setupBranch,
      base: branch,
      body: `${branch} is protected, so Broods could not commit \`${WORKFLOW_PATH}\` directly. Merge this to deploy on every push.`,
    },
  );

  return pull.html_url;
}

/** Cuts `branch` from `from`'s head; an existing one is left alone, or moved there with `reset`. */
export async function createBranch(
  app: GitHubApp,
  token: string,
  fullName: string,
  from: string,
  branch: string,
  reset = false,
): Promise<void> {
  const head = await githubRequest<{ object: { sha: string } }>(
    app,
    token,
    "GET",
    `/repos/${fullName}/git/ref/heads/${encodeURIComponent(from)}`,
  );
  try {
    await githubRequest(app, token, "POST", `/repos/${fullName}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: head.object.sha,
    });
  } catch (error) {
    if (!(error instanceof GitHubApiError) || error.status !== 422) throw error;
    if (!reset) return;
    await githubRequest(
      app,
      token,
      "PATCH",
      `/repos/${fullName}/git/refs/heads/${encodeURIComponent(branch)}`,
      { sha: head.object.sha, force: true },
    );
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
    for (const [stage, key] of deployKeyEntries(keys)) {
      const environment = `/repos/${fullName}/environments/${DEPLOY_ENVIRONMENTS[stage]}`;
      await githubRequest(app, token, "PUT", environment, {
        deployment_branch_policy: {
          protected_branches: false,
          custom_branch_policies: true,
        },
      });
      await allowOnlyBranch(app, token, environment, key.branch);
      await setSecret(
        app,
        token,
        `${environment}/secrets`,
        ENVIRONMENT_SECRET,
        key.token,
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
  for (const [stage, key] of deployKeyEntries(keys)) {
    await setSecret(
      app,
      token,
      `/repos/${fullName}/actions/secrets`,
      DEPLOY_TOKEN_SECRETS[stage],
      key.token,
    );
  }

  return false;
}

/** Creates `owner/name` as the signed-in user, on the installation's account. */
export async function createRepo(
  app: GitHubApp,
  userToken: string,
  installation: UserInstallation,
  repo: { name: string; private: boolean },
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

  return toRepo(installation.installationId, created);
}

/**
 * Lets the installation reach a repo the user just created and commits
 * `files` on its default branch. Nothing in them may run a workflow: the
 * deploy keys are sealed after this.
 */
export async function startRepo(
  app: GitHubApp,
  userToken: string,
  repo: GitHubRepo,
  files: Record<string, string>,
): Promise<void> {
  const token = await installationToken(app, repo.installationId);
  // An install on all repos reaches the new one; one on selected repos needs it added.
  const reached = await getRepo(app, token, repo.installationId, repo.repoId)
    .then(() => true)
    .catch((error: unknown) => {
      if (error instanceof GitHubApiError && error.status === 404) return false;
      throw error;
    });
  if (!reached) {
    await githubRequest(
      app,
      userToken,
      "PUT",
      `/user/installations/${repo.installationId}/repositories/${repo.repoId}`,
    );
  }
  const branch = encodeURIComponent(repo.defaultBranch);
  const head = await githubRequest<{ object: { sha: string } }>(
    app,
    token,
    "GET",
    `/repos/${repo.fullName}/git/ref/heads/${branch}`,
  );
  const parent = await githubRequest<{ tree: { sha: string } }>(
    app,
    token,
    "GET",
    `/repos/${repo.fullName}/git/commits/${head.object.sha}`,
  );
  const tree = await githubRequest<{ sha: string }>(
    app,
    token,
    "POST",
    `/repos/${repo.fullName}/git/trees`,
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
    `/repos/${repo.fullName}/git/commits`,
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
    `/repos/${repo.fullName}/git/refs/heads/${branch}`,
    { sha: commit.sha },
  );
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
  const digest = signature?.match(/^sha256=([0-9a-f]{64})$/)?.[1];
  if (!digest) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

  // WebCrypto's verify compares the MAC in constant time.
  return await crypto.subtle.verify(
    "HMAC",
    key,
    Uint8Array.from(digest.match(/../g) ?? [], (pair) => parseInt(pair, 16)),
    new TextEncoder().encode(body),
  );
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
    bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
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

  return `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

// Leaves `branch` as the only branch the environment deploys from, dropping an earlier link's.
async function allowOnlyBranch(
  app: GitHubApp,
  token: string,
  environment: string,
  branch: string,
): Promise<void> {
  const policies = `${environment}/deployment-branch-policies`;
  const { branch_policies } = await githubRequest<{
    branch_policies: Array<{ id: number; name: string }>;
  }>(app, token, "GET", `${policies}?per_page=100`);
  for (const policy of branch_policies) {
    if (policy.name === branch) continue;
    await githubRequest(app, token, "DELETE", `${policies}/${policy.id}`);
  }
  if (!branch_policies.some((policy) => policy.name === branch)) {
    await githubRequest(app, token, "POST", policies, {
      name: branch,
      type: "branch",
    });
  }
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left);
  joined.set(right, left.length);

  return joined;
}

function branchOf(target: WorkflowTarget, stage: Stage): string | undefined {
  return stage === "production"
    ? target.productionBranch
    : target.developmentBranch;
}

// The stages that have a key, with it.
function deployKeyEntries(
  keys: DeployKeys,
): Array<[Stage, { branch: string; token: string }]> {
  return STAGES.flatMap(
    (stage): Array<[Stage, { branch: string; token: string }]> => {
      const key = keys[stage];

      return key ? [[stage, key]] : [];
    },
  );
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

// One commit on `parentSha` for every file, so a change across files deploys once.
async function commitOn(
  app: GitHubApp,
  token: string,
  fullName: string,
  parentSha: string,
  files: readonly CommitFile[],
  message: string,
): Promise<{ sha: string; url: string }> {
  const parent = await githubRequest<{ tree: { sha: string } }>(
    app,
    token,
    "GET",
    `/repos/${fullName}/git/commits/${parentSha}`,
  );
  const tree = await githubRequest<{ sha: string }>(
    app,
    token,
    "POST",
    `/repos/${fullName}/git/trees`,
    {
      base_tree: parent.tree.sha,
      // A null blob sha removes the path from the base tree.
      tree: files.map((file) =>
        file.content === null
          ? { path: file.path, mode: "100644", type: "blob", sha: null }
          : {
              path: file.path,
              mode: "100644",
              type: "blob",
              content: file.content,
            },
      ),
    },
  );
  const commit = await githubRequest<{ sha: string; html_url: string }>(
    app,
    token,
    "POST",
    `/repos/${fullName}/git/commits`,
    { message: message, tree: tree.sha, parents: [parentSha] },
  );

  return { sha: commit.sha, url: commit.html_url };
}

async function branchHead(
  app: GitHubApp,
  token: string,
  fullName: string,
  branch: string,
): Promise<string> {
  const head = await githubRequest<{ object: { sha: string } }>(
    app,
    token,
    "GET",
    `/repos/${fullName}/git/ref/heads/${encodeURIComponent(branch)}`,
  );

  return head.object.sha;
}

async function listFiles(
  app: GitHubApp,
  token: string,
  fullName: string,
  branch: string,
): Promise<string[]> {
  const body = await githubRequest<{
    tree: Array<{ path: string; type: string }>;
    truncated: boolean;
  }>(
    app,
    token,
    "GET",
    `/repos/${fullName}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
  );
  // A partial tree could miss a root or the lockfile, so it is never answered as complete.
  if (body.truncated) {
    throw new ClientError(
      `${fullName} is too large for GitHub to list in one scan, so Broods cannot find its broods/ folder.`,
    );
  }

  return body.tree.filter((entry) => entry.type === "blob").map((e) => e.path);
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
      `/repos/${fullName}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch)}`,
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

// PKCS#8 wraps the PKCS#1 key: version 0, rsaEncryption, then the key as an octet string.
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
