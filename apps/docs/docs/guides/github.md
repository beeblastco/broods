# GitHub

Link a project to a GitHub repo and every push deploys it. Broods commits a workflow to the repo, so the deploy runs in your own GitHub Actions with the same `broods deploy` you run locally.

| Branch                        | Deploys to  |
| ----------------------------- | ----------- |
| The default branch, `main`    | Production  |
| The development branch, `dev` | Development |

## Start a project from GitHub

**Create project** offers three starts:

- **Empty**: no repo. Edit on the canvas or sync with `broods dev`.
- **Import repo**: pick a repo from a connected GitHub account. Broods finds the `broods/` folder, also inside a monorepo app such as `apps/web/broods/`, and links it.
- **New repo**: Broods creates the repo under the account you pick, with a `broods/` starter, the workflow and a `dev` branch. GitHub asks you to sign in first, because the repo is created as you.

An existing project links from **Settings > Git**.

The first time, an org admin connects GitHub: the Broods GitHub App installs on your user or organization, on all repos or the ones you pick. Add more accounts the same way.

## What linking writes

| In the repo                                              | What it is                                                  |
| -------------------------------------------------------- | ----------------------------------------------------------- |
| `.github/workflows/broods.yml` on both branches          | Installs your dependencies and runs `broods deploy --prune` |
| Secret `BROODS_PRODUCTION_TOKEN`                         | A project key that can deploy only Production               |
| Secret `BROODS_DEVELOPMENT_TOKEN`                        | A project key that can deploy only Development              |
| A `dev` branch, cut from the default branch when missing | Pick another name under Development branch                  |

The workflow detects bun, pnpm, yarn or npm from the lockfile nearest above `broods/`. It is a normal file: change the Node version, add tests before the deploy, or move the step into your own pipeline.

A protected default branch refuses a direct commit, so Broods opens a pull request with the workflow instead. Merge it to start deploying on push. **Settings > Git** links to it.

## Deploy status

**Settings > Git** shows the latest run on each branch: deploying, deployed or failed, with its commit and a link to the run on GitHub.

## Gotchas

- The repo is the source of truth for what `broods/` defines. `--prune` removes a resource from the stage when you delete it from code. Resources made on the dashboard stay; code-managed nodes are locked there.
- Secrets your agents read with `env("NAME")` are not in the repo. Set them per stage with `broods env set` or on the dashboard before the first push, or the deploy fails naming them.
- **Unlink** revokes both project keys and forgets the deploy history. The workflow file and the secrets stay in the repo; delete them there if you no longer want them.
- Uninstalling the App on GitHub, or removing a repo from it, unlinks every project on those repos.

See [Deploying](deploying.md) for running `broods deploy` from any other CI.
