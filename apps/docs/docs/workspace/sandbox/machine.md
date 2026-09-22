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
network drop, reclaiming its record as it does. Any other daemon, on any
computer, is refused while the record is held, and the refusal names the host
that holds it, so nobody takes over a machine by mistake:

```bash
broods machine my-mac --force    # take the record over from another daemon
```

A record is released the moment its daemon exits, so a normal restart never
needs the flag. The exception is a daemon killed while its network was down:
core notices the dead socket after a short timeout, and a restart before that
needs `--force`. It exits with core's reason on an invalid key, on a name with
no `machine` record, when refused, or when another daemon takes the record
over. A [role session](../../roles.md) needs `sandboxes:write` on the sandbox
to run `broods machine`; without it core answers as if the name had no record.

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

### More than one computer

An agent drives every machine in its `sandboxes`, wherever it sits in the list,
so one agent can drive several computers.

```ts
defineAgent({
  name: "tracy",
  sandboxes: [kienMac, phicksMac],
});
```

With one computer reachable, `computer` takes the action alone, as before. With
more, it takes a `sandbox` naming which computer to act on, and every result
says which screen it came from. Coordinates never carry from one screen to
another, so take a screenshot after switching.

Approval for an action follows the computer that call names, not the agent's
first sandbox: in one turn a `bypass` machine clicks without asking while an
`ask` machine still asks. Looking stays free on every machine, as above, so
`ask` does not stop an agent screenshotting one it can reach. What decides
whether it can reach a computer at all is the owner starting the daemon with
`--computer`, and Ctrl+C there ends it.

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
- The dashboard lists a connected computer in Sandboxes > Instances with its
  connection state, when it connected and when it was last seen, plus the
  command that starts it. It has no size, image, trace or lifecycle switch
  there, and no snapshot.
