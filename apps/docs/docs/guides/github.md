# GitHub

Link a project to a GitHub repo and every push to a stage's branch deploys that stage. Broods commits a workflow to the repo, so the deploy runs in your own GitHub Actions with the same `broods deploy` you run locally.

Each stage follows one branch, or none. Production gets one only when the project already has a Production stage, or you name a branch for it; Broods never adds Production on its own. By default:

| The project has  | The default branch, such as `main`, deploys | `dev` deploys |
| ---------------- | ------------------------------------------- | ------------- |
| Development only | Development                                 | nothing       |
| Production too   | Production                                  | Development   |

Name other branches with `--production-branch` and `--development-branch`, or `none` to leave a stage out.

## Start a project from GitHub

**Create project** offers three starts:

- **Empty**: no repo. Edit on the canvas or sync with `broods dev`.
- **Import repo**: pick a repo from a connected GitHub account. Broods finds the `broods/` folder, also inside a monorepo app such as `apps/web/broods/`, and links it.
- **New repo**: Broods creates the repo under the account you pick, with a `broods/` starter, the workflow and a `dev` branch. GitHub asks you to sign in first, because the repo is created as you.

An existing project links from **Settings > Git**, or from the CLI:

```bash
broods github repos
broods github link acme/web [--folder apps/web] [--production-branch <name|none>] [--development-branch <name|none>]
broods github status
```

See the [CLI reference](../reference/cli.md#github).

The first time, an org admin connects GitHub: the Broods GitHub App installs on your user or organization, on all repos or the ones you pick. Add more accounts the same way. Broods connects only the accounts you administer on GitHub, your own or an organization you are an admin of, because the App reaches every repo of an installation, not just the ones you can see.

## What linking writes

| In the repo                                              | What it is                                                  |
| -------------------------------------------------------- | ----------------------------------------------------------- |
| `.github/workflows/broods.yml` on each mapped branch     | Installs your dependencies and runs `broods deploy --prune` |
| Environment `broods-production`, secret `BROODS_TOKEN`   | A project key that can deploy only Production               |
| Environment `broods-development`, secret `BROODS_TOKEN`  | A project key that can deploy only Development              |
| A `dev` branch, cut from the default branch when missing | Pick another name under Development branch                  |

The workflow detects bun, pnpm, yarn or npm from the lockfile nearest above `broods/`. It is a normal file: change the Node version, add tests before the deploy, or move the step into your own pipeline.

A protected default branch refuses a direct commit, so Broods opens a pull request with the workflow instead. Merge it to start deploying on push. **Settings > Git** links to it.

Each key sits in an environment only its branch may deploy from, so a workflow on any other branch cannot read Production's key. GitHub Free has no environments on private repos; there the keys go in as repo secrets `BROODS_PRODUCTION_TOKEN` and `BROODS_DEVELOPMENT_TOKEN`, which any branch's workflow can read, and **Settings > Git** says so.

A repo deploys one project. Linking a repo another project already deploys from is refused until you unlink it there, and a linked project unlinks before it links another. The development branch must differ from the default branch; where `dev` is the default, Broods uses `development`.

## Deploy status

**Settings > Git** shows the latest run on each branch: deploying, deployed or failed, with its commit and a link to the run on GitHub.

## Gotchas

- The repo is the source of truth for what `broods/` defines. `--prune` removes a resource from the stage when you delete it from code. Resources made on the dashboard stay, and so do cron jobs your agents schedule at runtime; code-managed nodes are locked there.
- Secrets your agents read with `env("NAME")` are not in the repo. Set them per stage with `broods env set` or on the dashboard before the first push, or the deploy fails naming them.
- **Unlink** revokes both project keys and forgets the deploy history. The workflow file, the environments and the secrets stay in the repo; delete them there if you no longer want them.
- Uninstalling the App on GitHub, or removing a repo from it, unlinks every project on those repos.

See [Deploying](deploying.md) for running `broods deploy` from any other CI.
