# Documentation

Detailed project documentation lives here so the root README can stay short.

- [Architecture and workflows](architecture.md): account-based runtime architecture, webhook routing, async handling, memory boundaries, and storage ownership.
- [Account management](account-management.md): account creation, metadata, account secrets, encrypted config, channel setup, and admin operations.
- [Memory and session](memory-and-session.md): conversation keys, account-scoped memory, `memoryNamespace`, and filesystem sharing.
- [Data security](data-security.md): current account secret handling, encrypted config storage, redaction, limits, and production upgrade paths.
- [Direct API](direct-api.md): account-authenticated sync SSE requests, async requests, status polling, callback webhooks, and payload examples.
- [Operations](operations.md): SST secrets, deployment, post-deploy account setup, CI, and live probes.
- [Extending](extending.md): adding tools, channels, and commands.
