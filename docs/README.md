# Documentation

Detailed project documentation lives here so the root README can stay short.

- [Architecture and workflows](architecture.md): account-based runtime architecture, webhook routing, async handling, memory boundaries, and storage ownership.
- [Account management](account-management.md): account creation, metadata, account secrets, encrypted config, channel setup, and admin operations.
- [Memory and session](memory-and-session.md): conversation keys, account-scoped workspace memory, tasks, and filesystem sharing.
- [Sub agents](sub-agents.md): run_subagent dispatch, predefined and virtual subagents, context inheritance, and SSE continuation.
- [Data security](data-security.md): current account secret handling, encrypted config storage, redaction, limits, and production upgrade paths.
- [Direct API](direct-api.md): account-authenticated sync SSE requests, async requests, status polling, and payload examples.
- [Lifecycle webhooks](webhook.md): agent event webhook configuration, event names, payloads, and signatures.
- [External tools](tools.md): external model tools, tool execution flow, approval handling, and adding new external integrations.
- [Channels](channels.md): communication channel adapters, webhook normalization, reply actions, and adding new channel integrations.
- [Operations](operations.md): SST secrets, deployment, post-deploy account setup, CI, and live probes.
- [Extending](extending.md): routing guide for extension docs and adding commands.
