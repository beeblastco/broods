# Documentation

Detailed project documentation lives here so the root README can stay short.

- Core
  - [Getting Started](getting-started.md): local setup and first request.
  - [Architecture and Workflow](architecture.md): runtime architecture, routing, async handling, memory boundaries, and storage ownership.
  - [Data Security](data-security.md): account secret handling, encrypted config storage, redaction, limits, and upgrade paths.
- Features
  - [Memory and Session](memory-and-session.md): conversation keys, account-scoped workspace memory, tasks, and filesystem sharing.
  - [Lifecycle Webhook](webhook.md): agent event webhook configuration, event names, payloads, and signatures.
  - [External Tool](tools.md): external model tools, tool execution flow, approval handling, and adding new integrations.
  - [Channels](channels.md): communication channel adapters, webhook normalization, reply actions, and adding new channel integrations.
  - [Sandbox](sandbox.md): file-based JavaScript/TypeScript/Python execution, providers, runtime Lambdas, and security boundaries.
  - [Subagent](sub-agents.md): run_subagent dispatch, predefined and virtual subagents, context inheritance, and SSE continuation.
- Development
  - [Extending](extending.md): routing guide for extension docs and adding commands.
  - [Deployment](deployment.md): SST secrets, deployment, post-deploy account setup, and live probes.
  - [CI/CD](ci-cd.md): GitHub Actions deployment and integration account setup.
- API Reference
  - [Overview](api-reference.md): OpenAPI spec links and supporting guide links.
  - [Direct API](direct-api.md): harness-processing endpoints for sync SSE, async work, status polling, and external tool completion.
  - [Account Management](account-management.md): account, agent, skill, and secret-management endpoints.
