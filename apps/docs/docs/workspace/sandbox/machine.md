# Machine (your computer)

The `machine` provider makes the user's own computer the sandbox. The agent
keeps running in the cloud. Its `bash` tool runs on that computer, as that
user, with that user's `PATH`, environment and installed tools: browsers,
cloud CLIs, Blender, anything a shell can reach.

Nothing is opened inbound. The computer runs `broods machine <sandbox>`, which
keeps one WebSocket open to the gateway. Core sends each command down that
socket and waits for the output. When the daemon is not running, the tool
returns a clear error and the run carries on.

Leave `permissionMode` on `ask` unless you really mean `bypass`. This is your
machine.

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

Validation refuses what a laptop cannot honour: `persistent`, `size`,
`snapshot`, `memoryLimit`, and any `network.mode` but `allow-all`.

## Run the daemon

```bash
broods machine my-mac            # uses BROODS_API_KEY from .env.local, like `broods logs`
broods machine my-mac --cwd ~/Projects/app
```

It prints one line per command and the exit code, reconnects after a network
drop, and stops with the reason when core refuses it: an invalid key, no
`machine` record by that name in the account, or a newer daemon that took the
same record over. Last daemon wins, so restarting it never needs the old one
gone first.

## What it does not do

- No workspaces. The file tools come with an S3-backed workspace mount, and a
  laptop has no mount. `bash` covers reading and writing files.
- No background jobs, snapshots, suspend or resume.
- No dashboard presence. The instance list shows reserved cloud sandboxes only.
