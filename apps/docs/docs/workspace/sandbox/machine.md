# Machine (your computer)

The `machine` provider runs the agent's `bash` tool on your own computer. The
agent stays in the cloud. Commands run as you, with your `PATH`, environment
and installed tools.

Your computer opens no port. `broods machine <sandbox>` keeps one WebSocket
open to the gateway, and core sends each command down it. When the daemon is
not running, the tool call fails with the command that starts it.

Keep `permissionMode` on `ask`. With `bypass` the agent runs any command on
your computer without asking.

## Config

```jsonc
{
  "name": "my-mac",
  "config": {
    "provider": "machine",
    "permissionMode": "ask",
    "network": { "mode": "allow-all" },
    "options": {
      "cwd": "/Users/me/Projects/app", // optional; default is where the daemon started
    },
    "envVars": { "FOO": "bar" }, // merged over the host environment
  },
}
```

Validation rejects `persistent`, `size`, `snapshot`, `memoryLimit`, and any
`network.mode` other than `allow-all`.

## Run the daemon

```bash
broods machine my-mac            # uses BROODS_API_KEY from .env.local, like `broods logs`
broods machine my-mac --cwd ~/Projects/app
```

The daemon prints each command with its exit code and reconnects after a
network drop. It exits with core's reason on an invalid key, on a name with no
`machine` record, or when a newer daemon claims the same record. The newest
daemon always wins, so a restart never waits for the old one.

## Limits

- No workspaces. The file tools need the S3 workspace mount, which a computer
  does not have. Use `bash` to read and write files.
- No background jobs, snapshots, suspend or resume.
- The dashboard instance list does not show machines.
