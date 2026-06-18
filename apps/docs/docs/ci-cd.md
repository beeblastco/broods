# CI/CD

GitHub Actions runs CI on pull requests and pushes. Both workflows skip docs-only changes (`docs/**`, `**/*.md`).

Deploys run on push to two branches, plus manual `workflow_dispatch` with a stage input:

| Branch | Stage | Notes |
| --- | --- | --- |
| `dev` | `dev` | re-runs validation before deploying; DynamoDB storage |
| `main` | `production` | skips re-validation; Convex storage |

A separate workflow (`deploy-docs.yaml`) builds the Docusaurus site on `main` pushes touching docs and syncs it to S3 + CloudFront (vars `DOCS_S3_BUCKET`, `DOCS_DOMAIN`).

## Required Secrets and Variables

The deploy step hard-fails without these repository secrets:

- `SST_SECRET_ADMINACCOUNTSECRET`
- `SST_SECRET_ACCOUNTCONFIGENCRYPTIONSECRET`
- `SST_SECRET_GOOGLEAPIKEY`
- `SST_SECRET_TAVILYAPIKEY`
- `DAYTONA_API_KEY` (mapped to the `DaytonaApiKey` SST secret)
- `MOCK_WEBHOOK_SECRET`

`KUBERNETES_SANDBOX_KUBECONFIG` is optional (enables the Kubernetes sandbox provider).

And these repository variables: `AWS_REGION`, `AWS_ROLE_ARN`, `AWS_ACCOUNT_ID`, `PROJECT_NAME`, `PROJECT_OWNER_EMAIL`.

## Channel Setup

Infrastructure deploys no longer create demo accounts or register provider webhooks. Channel agents are declared with the CLI SDK and synchronized independently through `filthy-panty dev` or `filthy-panty deploy`. See the runnable `packages/demos/channel-*` packages for provider-specific setup and optional registration commands.
