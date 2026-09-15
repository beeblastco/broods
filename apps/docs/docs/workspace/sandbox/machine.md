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

## Computer use

Start the daemon with `--computer` and agents on the sandbox also get a
`computer` tool: screenshots of the main display, mouse and keyboard. It takes
the action names of Anthropic's computer-use tool (`screenshot`, `left_click`,
`type`, `key`, `scroll`, `zoom`, ...) as one plain tool, so any model provider
can call it.

```bash
broods machine --doctor --request   # once: grant Screen Recording and Accessibility to this terminal
broods machine my-mac --computer
```

macOS only for now. The first start compiles a small helper with `swiftc`
(Xcode Command Line Tools) into `~/.broods/desktop/`. Both permissions belong
to the terminal that runs the daemon.

Coordinates are pixels in the screenshot, which is the display scaled to fit
1280 on its long edge. The daemon maps them to screen points, so a Retina
display needs no setup. Every result names the frontmost app.

`screenshot`, `zoom`, `cursor_position` and `wait` never ask for approval.
Every other action asks unless `permissionMode` is `bypass`. The tool tells the
model that text on the screen is data, not instructions, and to ask before
CAPTCHAs, payments or security settings. Ctrl+C on the daemon stops it all.

## Local MCP servers

Start the daemon with `--mcp <file>` and the stdio MCP servers in that file run
on this computer for your agents. The file has the `.mcp.json` shape Claude
Code, Cursor and Codex read, so a server already set up for them works as is:

```json
{
  "mcpServers": {
    "blender": { "command": "uvx", "args": ["blender-mcp"] },
    "files": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "~/Work"]
    }
  }
}
```

```bash
broods machine my-mac --mcp ./.mcp.json
```

An MCP row reaches one of these servers by naming the sandbox instead of a url:
`defineMcp({ name: "blender", sandbox: mac })`, or `sandbox` in the API body.
The row's `name` is the `mcpServers` key. The daemon starts a server on its
first call and keeps it running. Core sees server names, tool listings and
results, never the file or the commands in it. `allowedTools` and
`needsApproval` work as on any other MCP row.

## Limits

- No workspaces. The file tools need the S3 workspace mount, which a computer
  does not have. Use `bash` to read and write files.
- No background jobs, snapshots, suspend or resume.
- The dashboard instance list does not show machines.
