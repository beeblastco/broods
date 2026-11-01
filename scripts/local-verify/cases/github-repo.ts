import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { BroodsSyncClient } from "../../../packages/broods/src/sync.ts";
import type { Doc } from "../../../packages/convex/_generated/dataModel.ts";
import { startFakeGitHub, type FakeGitHub } from "../fake-github.ts";
import {
  assertStep,
  convexOutputJson,
  SELF_HOST_IDENTITY,
  type VerifyContext,
} from "../harness.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const CLI = join(REPO_ROOT, "packages", "broods", "src", "cli", "index.ts");
const SDK = join(REPO_ROOT, "packages", "broods", "src", "index.ts");
const WORKFLOW = ".github/workflows/broods.yml";
const USER = { login: "octo", code: "octo-code" };
const USER_INSTALLATION = 101;
const ORG_INSTALLATION = 202;
const ORG_REPO = 9001;

interface Status {
  configured: boolean;
  canConnect: boolean;
  installations: Array<{ installationId: number; login: string }>;
  repo?: {
    fullName: string;
    rootDirectory: string;
    productionBranch: string;
    developmentBranch?: string;
    setupPullRequestUrl?: string;
  };
  deploys: Array<{ branch: string; status: string; conclusion?: string }>;
}

/** What every step shares: the stack, the fake and the admin's calls. */
interface Run {
  context: VerifyContext;
  github: FakeGitHub;
  workspace: string;
  /** Runs a dashboard function as the admin, without blocking the fake GitHub. */
  asAdmin: (fn: string, args: Record<string, unknown>) => Promise<unknown>;
  refused: (fn: string, args: Record<string, unknown>) => Promise<void>;
  status: (projectId: string) => Promise<Status>;
}

/** An imported project and the keys GitHub holds for it. */
interface Imported {
  projectId: string;
  slug: string;
  production: string;
  development: string;
}

/**
 * A GitHub repo link end to end, against a fake GitHub: the admin connects
 * the App, imports a monorepo whose `broods/` sits in `apps/agents`, and
 * Broods seals one project key per stage into repo secrets and commits the
 * deploy workflow (through a PR on the protected `main`, directly on `dev`).
 * The real CLI then deploys each stage with the secret GitHub Actions would
 * hand it, the `workflow_run` webhook lands on the dashboard, and an unlink
 * revokes the keys. Creating a repo and an uninstall run the same way.
 */
export async function githubRepo(context: VerifyContext): Promise<void> {
  const asAdmin = async (
    fn: string,
    args: Record<string, unknown>,
  ): Promise<unknown> => {
    const cli = await context.convexAsync(adminRun(fn, args));
    assertStep(`${fn} answers the admin`, cli.ok, cli.output.slice(-300));

    return convexOutputJson(cli.output);
  };
  const github = startFakeGitHub({
    ...context.github,
    installations: [
      { id: USER_INSTALLATION, login: USER.login, type: "User" },
      { id: ORG_INSTALLATION, login: "acme", type: "Organization" },
    ],
    user: USER,
  });
  const run: Run = {
    context: context,
    github: github,
    workspace: mkdtempSync(join(tmpdir(), "broods-github-")),
    asAdmin: asAdmin,
    refused: async (
      fn: string,
      args: Record<string, unknown>,
    ): Promise<void> => {
      const cli = await context.convexAsync(adminRun(fn, args));
      assertStep(`${fn} is refused`, !cli.ok, cli.output.slice(-300));
    },
    status: async (projectId: string): Promise<Status> =>
      (await asAdmin("github:status", { projectId: projectId })) as Status,
  };
  await asAdmin("user:ensureSynced", {});
  const previous = (await asAdmin(
    "org/orgs:getActive",
    {},
  )) as Doc<"orgs"> | null;
  const orgId = String(
    await asAdmin("org/orgs:create", { name: `github-${context.runId}` }),
  );
  try {
    await asAdmin("org/orgs:setActive", { orgId: orgId });
    context.convex([
      "run",
      "--identity",
      SELF_HOST_IDENTITY,
      "org/lifecycle:provision",
      JSON.stringify({ orgId: orgId }),
    ]);
    const imported = await importRepo(run);
    await deployFromRepo(run, imported);
    const created = await createRepo(run);
    await uninstall(run, created);
  } finally {
    github.stop();
    rmSync(run.workspace, { recursive: true, force: true });
    if (previous) await asAdmin("org/orgs:setActive", { orgId: previous._id });
    await asAdmin("org/orgs:remove", { orgId: orgId });
  }
}

// Connect the App, scan acme/web for broods/, and link it.
async function importRepo(run: Run): Promise<Imported> {
  const { projectId, slug } = await newProject(run, "gh-import");
  await connect(run, projectId);
  await scan(run, projectId);

  return await link(run, projectId, slug);
}

// GitHub returns to the callback with the code and the installation.
async function connect(run: Run, projectId: string): Promise<void> {
  const { context, github, asAdmin } = run;
  github.addRepo({
    id: ORG_REPO,
    fullName: "acme/web",
    installationId: ORG_INSTALLATION,
    protectedBranches: ["main"],
    files: {
      "bun.lock": "{}\n",
      "package.json": '{ "name": "web", "private": true }\n',
      "apps/agents/broods/index.ts": agentSource("imported-agent"),
      "apps/agents/broods/_generated/api.ts": "export {};\n",
      "node_modules/pkg/broods/index.ts": "export {};\n",
    },
  });
  const fresh = await run.status(projectId);
  assertStep(
    "an org admin sees GitHub configured with nothing connected",
    fresh.configured && fresh.canConnect && fresh.installations.length === 0,
    JSON.stringify(fresh),
  );

  const install = (await asAdmin("github:begin", {})) as { url: string };
  const state = new URL(install.url).searchParams.get("state") ?? "";
  assertStep(
    "connect opens the App's install page",
    new URL(install.url).pathname ===
      `/apps/${context.github.slug}/installations/new` && state.length > 0,
    install.url,
  );
  await context.measure("finish the GitHub install", async () =>
    asAdmin("github:finish", {
      state: state,
      code: USER.code,
      installationId: ORG_INSTALLATION,
    }),
  );
  assertStep(
    "both installations the user reaches are connected",
    (await run.status(projectId)).installations.length === 2,
    JSON.stringify((await run.status(projectId)).installations),
  );
  await run.refused("github:finish", { state: state, code: USER.code });
}

// The import list, then where broods/ sits in the picked repo.
async function scan(run: Run, projectId: string): Promise<void> {
  const { context, asAdmin } = run;
  const repos = (await context.measure("list the importable repos", async () =>
    asAdmin("github:listRepos", { projectId: projectId }),
  )) as Array<{ fullName: string }>;
  assertStep(
    "the import list holds the org's repo",
    repos.some((repo) => repo.fullName === "acme/web"),
    JSON.stringify(repos),
  );
  const { roots } = (await asAdmin("github:inspectRepo", {
    projectId: projectId,
    installationId: ORG_INSTALLATION,
    repoId: ORG_REPO,
  })) as { roots: Array<Record<string, string>> };
  assertStep(
    "the scan finds broods/ in apps/agents, installed with bun from the root",
    roots.length === 1 &&
      roots[0]?.rootDirectory === "apps/agents" &&
      roots[0]?.installDirectory === "" &&
      roots[0]?.manager === "bun",
    JSON.stringify(roots),
  );
  await run.refused("github:inspectRepo", {
    projectId: projectId,
    installationId: 999,
    repoId: ORG_REPO,
  });
}

// The link: secrets, the dev branch, and the workflow (a PR on the protected main).
async function link(
  run: Run,
  projectId: string,
  slug: string,
): Promise<Imported> {
  const { context, github, asAdmin } = run;
  const linked = (await context.measure("link the repo", async () =>
    asAdmin("github:linkRepo", {
      projectId: projectId,
      target: {
        installationId: ORG_INSTALLATION,
        repoId: ORG_REPO,
        rootDirectory: "apps/agents",
        baseUrl: context.edgeUrl,
      },
    }),
  )) as NonNullable<Status["repo"]>;
  assertStep(
    "the protected main gets the workflow through a PR",
    linked.setupPullRequestUrl === "https://github.com/acme/web/pull/1" &&
      github.filesAt(ORG_REPO, "main")?.has(WORKFLOW) === false,
    JSON.stringify(linked),
  );
  const workflow = github.filesAt(ORG_REPO, "dev")?.get(WORKFLOW) ?? "";
  const expected = [
    'branches: ["main", "dev"]',
    'working-directory: "apps/agents"',
    "bunx broods deploy",
    `BROODS_PROJECT: "${slug}"`,
    `BROODS_BASE_URL: "${context.edgeUrl}"`,
  ];
  assertStep(
    "dev gets the workflow directly, the same one the PR carries",
    expected.every((line) => workflow.includes(line)) &&
      github.filesAt(ORG_REPO, "broods/deploy-workflow")?.get(WORKFLOW) ===
        workflow,
    workflow,
  );
  const secrets = github.repos.get(ORG_REPO)?.secrets;
  const production = secrets?.get("BROODS_PRODUCTION_TOKEN") ?? "";
  const development = secrets?.get("BROODS_DEVELOPMENT_TOKEN") ?? "";
  assertStep(
    "each stage's project key is sealed into a repo secret",
    production.startsWith("bpdk_") &&
      development.startsWith("bpdk_") &&
      production !== development,
    [...(secrets?.keys() ?? [])].join(","),
  );

  return {
    projectId: projectId,
    slug: slug,
    production: production,
    development: development,
  };
}

// What GitHub Actions runs on a push to dev and to main, then its webhook, then an unlink.
async function deployFromRepo(run: Run, imported: Imported): Promise<void> {
  const { context, github } = run;
  const { slug, production, development } = imported;
  const checkout = join(run.workspace, "acme-web");
  writeFiles(checkout, github.filesAt(ORG_REPO, "dev"));
  const agents = join(checkout, "apps", "agents");
  const dev = deploy(context, agents, slug, "development", development);
  assertStep("dev's key deploys Development", dev.ok, dev.output);
  const manifest = await new BroodsSyncClient({
    baseUrl: context.edgeUrl,
    token: development,
  }).getManifest(slug, "development");
  const names = manifest?.manifest.resources.map((resource) => resource.name);
  assertStep(
    "Development holds the repo's agent",
    names?.includes("imported-agent") === true,
    JSON.stringify(names),
  );
  const crossed = deploy(context, agents, slug, "production", development);
  assertStep("dev's key cannot deploy Production", !crossed.ok, crossed.output);
  const prod = deploy(context, agents, slug, "production", production);
  assertStep("main's key deploys Production", prod.ok, prod.output);

  const hook = `${context.configPlaneUrl}/github/webhook`;
  const unsigned = await github.deliver(
    hook,
    "workflow_run",
    workflowRun(2, "success"),
    "wrong-secret",
  );
  assertStep(
    "an unsigned delivery is refused",
    unsigned === 401,
    `${unsigned}`,
  );
  const signed = await github.deliver(
    hook,
    "workflow_run",
    workflowRun(2, "success"),
  );
  assertStep("a signed workflow_run is accepted", signed === 204, `${signed}`);
  // An older run's event arriving late must not replace the newer result.
  await github.deliver(hook, "workflow_run", workflowRun(1, null));
  const deploys = (await run.status(imported.projectId)).deploys;
  assertStep(
    "the dashboard shows dev's latest run",
    deploys.length === 1 &&
      deploys[0]?.branch === "dev" &&
      deploys[0]?.conclusion === "success",
    JSON.stringify(deploys),
  );

  await run.asAdmin("github:unlinkRepo", { projectId: imported.projectId });
  const revoked = deploy(context, agents, slug, "development", development);
  const after = await run.status(imported.projectId);
  assertStep(
    "unlinking revokes the keys and clears the link and its runs",
    !revoked.ok && after.repo === undefined && after.deploys.length === 0,
    revoked.output,
  );
}

// A new repo under the user's account, created with their token; answers its project.
async function createRepo(run: Run): Promise<string> {
  const { context, github, asAdmin } = run;
  const { projectId, slug } = await newProject(run, "gh-new");
  const name = `agents-${context.runId}`;
  const begun = (await asAdmin("github:begin", {
    createRepo: {
      projectId: projectId,
      owner: USER.login,
      name: name,
      private: true,
      baseUrl: context.edgeUrl,
    },
  })) as { url: string };
  const url = new URL(begun.url);
  assertStep(
    "creating a repo signs the user in first",
    url.pathname === "/login/oauth/authorize" &&
      url.searchParams.get("client_id") === context.github.clientId,
    begun.url,
  );
  const finished = (await context.measure("create the repo", async () =>
    asAdmin("github:finish", {
      state: url.searchParams.get("state") ?? "",
      code: USER.code,
    }),
  )) as { projectId?: string };
  const created = [...github.repos.values()].find(
    (repo) => repo.fullName === `${USER.login}/${name}`,
  );
  assertStep(
    "the repo is created and given to the user's installation",
    finished.projectId === projectId &&
      created?.installationId === USER_INSTALLATION,
    JSON.stringify({
      finished: finished,
      installation: created?.installationId,
    }),
  );
  const main = github.filesAt(created.id, "main");
  const files = [...(main?.keys() ?? [])].sort();
  assertStep(
    "its first commit holds broods/ and the workflow, and dev is cut from it",
    ["README.md", "broods/index.ts", WORKFLOW].every((file) =>
      files.includes(file),
    ) && github.filesAt(created.id, "dev") !== null,
    JSON.stringify(files),
  );
  const status = await run.status(projectId);
  assertStep(
    "both secrets are set and the project is linked",
    created.secrets.size === 2 &&
      status.repo?.fullName === `${USER.login}/${name}` &&
      status.repo.developmentBranch === "dev",
    JSON.stringify(status),
  );
  const checkout = join(run.workspace, name);
  writeFiles(checkout, main);
  const token = created.secrets.get("BROODS_DEVELOPMENT_TOKEN") ?? "";
  const first = deploy(context, checkout, slug, "development", token);
  assertStep("the starter deploys green", first.ok, first.output);

  return projectId;
}

// Uninstalling from GitHub unlinks that account's repos and forgets it.
async function uninstall(run: Run, projectId: string): Promise<void> {
  const { context, github } = run;
  assertStep(
    "the new repo's project is linked through the user's installation",
    (await run.status(projectId)).repo !== undefined,
    "unlinked",
  );
  await github.deliver(
    `${context.configPlaneUrl}/github/webhook`,
    "installation",
    { action: "deleted", installation: { id: USER_INSTALLATION } },
  );
  const after = await run.status(projectId);
  assertStep(
    "uninstalling the App unlinks its repos and forgets the account",
    after.repo === undefined &&
      after.installations.length === 1 &&
      after.installations[0]?.installationId === ORG_INSTALLATION,
    JSON.stringify(after),
  );
}

function agentSource(name: string): string {
  return [
    `import { defineAgent } from ${JSON.stringify(SDK)};`,
    "",
    "export const agent = defineAgent({",
    `  name: ${JSON.stringify(name)},`,
    '  model: { provider: "anthropic", modelId: "claude-haiku-5-5" },',
    '  agent: { system: "Reply OK." },',
    "});",
    "",
  ].join("\n");
}

// The step the workflow runs: `broods deploy --stage <stage> --prune` with that stage's secret.
function deploy(
  context: VerifyContext,
  cwd: string,
  project: string,
  stage: string,
  token: string,
): { ok: boolean; output: string } {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("BROODS_")),
  );
  const result = spawnSync(
    "bun",
    [CLI, "deploy", "--stage", stage, "--prune"],
    {
      cwd: cwd,
      encoding: "utf8",
      env: {
        ...env,
        BROODS_BASE_URL: context.edgeUrl,
        BROODS_PROJECT: project,
        BROODS_TOKEN: token,
        NO_COLOR: "1",
      },
    },
  );

  return {
    ok: result.status === 0,
    output: `${result.stdout}${result.stderr}`.slice(-600),
  };
}

async function newProject(
  run: Run,
  prefix: string,
): Promise<{ projectId: string; slug: string }> {
  const projectId = String(
    await run.asAdmin("project:create", {
      name: `${prefix}-${run.context.runId}`,
    }),
  );
  const project = (await run.asAdmin("project:getById", {
    projectId: projectId,
  })) as {
    slug: string;
  };

  return { projectId: projectId, slug: project.slug };
}

function workflowRun(id: number, conclusion: string | null): unknown {
  return {
    action: conclusion ? "completed" : "in_progress",
    repository: { id: ORG_REPO },
    workflow_run: {
      id: id,
      path: WORKFLOW,
      head_branch: "dev",
      head_sha: "abc123",
      status: conclusion ? "completed" : "in_progress",
      conclusion: conclusion,
      html_url: `https://github.com/acme/web/actions/runs/${id}`,
    },
  };
}

function writeFiles(root: string, files: Map<string, string> | null): void {
  for (const [path, content] of files ?? []) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

// `convex run` as the self-hosted admin, the way the dashboard calls it signed in.
function adminRun(fn: string, args: Record<string, unknown>): string[] {
  return ["run", "--identity", SELF_HOST_IDENTITY, fn, JSON.stringify(args)];
}
