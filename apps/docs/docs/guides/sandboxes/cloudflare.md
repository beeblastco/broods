# Cloudflare Containers

The `cloudflare` provider runs the agent's `bash` tool in a [Cloudflare Container](https://developers.cloudflare.com/sandbox/). The image has `bash`, `python3`, Node 24, `git` and `ripgrep`.

```ts
import { defineAgent, defineSandbox } from "broods";

export const box = defineSandbox({
  name: "cloudflare",
  provider: "cloudflare",
  persistent: true,
  size: "small",
  network: { mode: "allow-all" },
  permissionMode: "ask",
  lifecycle: { idleTimeoutSeconds: 600 },
  envVars: { MY_API_BASE: "https://api.example.com" },
});

export const helper = defineAgent({
  name: "helper",
  sandboxes: [box],
});
```

| Field                          | Behavior                                                                                             |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `persistent`                   | `true` keeps one Container per agent while it is warm. `false` uses a new one per call               |
| `lifecycle.idleTimeoutSeconds` | How long a warm Container waits for the next command before it sleeps. Default 15 minutes            |
| `network.mode`                 | `allow-all` turns internet on. `deny-all` turns it off. `restricted` is rejected                     |
| `size`                         | Picks the nearest Cloudflare instance type, from `standard-1` for `tiny` to `standard-4` for `large` |
| `options`                      | Only `workspaceRoot` and `reservationKey`                                                            |

## Gotchas

- A Container that sleeps loses its files. Persistence keeps installs and files between calls only while the Container stays warm. Put anything you need back into a setup step the agent can rerun.
- Workspaces are not supported. Attaching one fails.
- `onCreate`, `onResume`, `snapshot` and `lifecycle.maxLifetimeSeconds` are rejected.
- Background jobs, suspend, resume and Create snapshot are not available.
- `config.harness` agents cannot run on this provider. Use `sandbox` or `lambda`.
- The dashboard runs commands through its bounded runner. The API's `terminal` action opens a PTY only on a running Container, so run a command first to wake it.
- The provider runs only where the deployment runs its Cloudflare bridge. Without it every run fails with an error saying the bridge is not configured. A self-hosted deployment deploys its own, see [Sandbox internals](../../internals/sandboxes.md#cloudflare).
