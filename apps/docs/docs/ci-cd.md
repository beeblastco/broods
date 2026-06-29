# CI/CD

GitHub Actions runs CI on pull requests and pushes. Both workflows skip docs-only changes (`docs/**`, `**/*.md`).

Deploys run on push to two branches, plus manual `workflow_dispatch` with a stage input:

| Branch | Stage | Notes |
| --- | --- | --- |
| `dev` | `dev` in `eu-west-1` by default | re-runs validation before deploying; DynamoDB or dev Convex storage |
| `main` | `production-eu-west-1` | skips re-validation; uses the production Convex deployment |

A separate workflow (`deploy-docs.yaml`) builds the Docusaurus site on `main` pushes touching docs and syncs it to S3 + CloudFront (vars `DOCS_S3_BUCKET`, `DOCS_DOMAIN`).

The npm package workflow is split in two:

- `check-broods-sdk.yaml` runs automatically on pull requests and non-`main` pushes that touch `packages/broods/**`, root package metadata, `bun.lock`, or the SDK npm workflows. It typechecks, tests, builds, and dry-run packs the package so source files, tests, and local env files cannot slip into the tarball.
- `publish-npm.yaml` runs only on `main` pushes that touch the SDK package, root package metadata, `bun.lock`, or the npm publish workflow, and as the final bot-dispatched step of the `Promote dev to main` production workflow. It publishes `packages/broods` to npm through npm Trusted Publishing (OIDC) only when the package version is not already present in the registry. Non-`main` pushes and user-dispatched publish runs do not publish to npm.

## Required Secrets and Variables

The deploy step hard-fails without these repository secrets:

- `SST_SECRET_ADMINACCOUNTSECRET`
- `SST_SECRET_ACCOUNTCONFIGENCRYPTIONSECRET`
- `SST_SECRET_GOOGLEAPIKEY`
- `SST_SECRET_TAVILYAPIKEY`
- `DAYTONA_API_KEY` (mapped to the `DaytonaApiKey` SST secret)

And these repository variables: `AWS_ROLE_ARN`, `AWS_ACCOUNT_ID`, `PROJECT_NAME`, `PROJECT_OWNER_EMAIL`.
`DEV_AWS_REGION` controls the dev stack and defaults to `eu-west-1`. Production currently deploys
to `eu-west-1` (Ireland) only. The production Convex database remains in `eu-west-1`.
`us-east-1` and `ap-southeast-1` remain planned production regions, but they are disabled until
the production rollout is reviewed and explicitly promoted.

The npm publish workflow must be configured as a Trusted Publisher for the npm package `broods`. Use GitHub Actions with organization/user `beeblastco`, repository `broods`, workflow filename `publish-npm.yaml`, and allowed action `npm publish`. Do not commit `.npmrc` files or npm tokens; Trusted Publishing does not require `NPM_TOKEN`.

## Channel Setup

Infrastructure deploys no longer create demo accounts or register provider webhooks. Channel agents are declared with the CLI SDK and synchronized independently through `broods dev` or `broods deploy`. See the runnable `packages/demos/channel-*` packages for provider-specific setup and optional registration commands.
