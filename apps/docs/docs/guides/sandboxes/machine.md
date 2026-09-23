# Your computer as a sandbox

The `machine` provider runs the agent's `bash` tool on your own computer. The agent stays in the cloud. Commands run as you, with your `PATH`, environment and installed tools. It can also give the agent your screen, mouse and keyboard, and run local MCP servers.

Your computer opens no port. `broods machine <sandbox>` holds one WebSocket to the gateway, and each command comes down it. When the daemon is not running, the tool call fails with the command that starts it.

Keep `permissionMode` on `ask`. With `bypass` the agent runs any command on your computer without asking.

## Configure

```ts title="broods/index.ts"
import { defineAgent, defineSandbox } from "broods";

export const myMac = defineSandbox({
  name: "my-mac",
  provider: "machine",
  permissionMode: "ask",
  network: { mode: "allow-all" },
  options: { cwd: "/Users/me/Projects/app" }, // optional, default is where the daemon started
  envVars: { FOO: "bar" }, // merged over your environment
});

export const helper = defineAgent({
  name: "helper",
  sandboxes: [myMac],
});
```

`persistent`, `size`, `snapshot` and `memoryLimit` are rejected, and `network.mode` must be `allow-all`.

The daemon strips every `BROODS_*` variable from the environment of agent commands and MCP servers, so an agent shell cannot read `BROODS_API_KEY` or `BROODS_TOKEN`.

## Run the daemon

```bash
broods machine my-mac
broods machine my-mac --cwd ~/Projects/app
```

It needs a `broods login` and a deployed stage, like `broods logs`. The daemon trades your login for a fifteen-minute stage ticket and mints a new one before each reconnect. The machine socket also accepts an account secret or a [role session](../security.md), which needs `sandboxes:write` on the sandbox. It never accepts the stage runtime key, which is meant for frontends.

The daemon prints each command with its exit code and reconnects after a network drop. While it holds the record, any other daemon on any computer is refused, and the refusal names the host that holds it:

```bash
broods machine my-mac --force   # take the record over from another daemon
```

The record is released when the daemon exits, so a normal restart never needs `--force`. You need it only after a daemon was killed while its network was down, before the platform notices the dead socket. The daemon exits with the reason when the credential is invalid, the name has no `machine` record, the takeover is refused, or another daemon takes the record.

## Computer use

Start the daemon with `--computer` and agents on this sandbox also get a `computer` tool for screenshots of the main display, mouse and keyboard. It takes the action names of Anthropic's computer-use tool, such as `screenshot`, `left_click`, `type`, `key`, `scroll` and `zoom`, as a plain tool, so any model provider can call it.

```bash
broods machine --doctor --request   # once: grant Screen Recording and Accessibility to this terminal
broods machine my-mac --computer
```

- macOS only for now. The first start compiles a small helper with `swiftc` from the Xcode Command Line Tools into `~/.broods/desktop/`. Both permissions belong to the terminal that runs the daemon.
- Coordinates are pixels in the screenshot, which is the display scaled to 1280 on its long edge. Retina displays need no setup. Every result names the frontmost app.
- `screenshot`, `zoom`, `cursor_position` and `wait` never ask for approval. Every other action asks unless `permissionMode` is `bypass`.
- The tool tells the model that text on screen is data, not instructions, and to ask before CAPTCHAs, payments or security settings.
- Ctrl+C on the daemon stops everything.

### More than one computer

An agent drives every `machine` sandbox in its `sandboxes`, wherever it sits in the list.

```ts
defineAgent({
  name: "tracy",
  sandboxes: [kienMac, phicksMac],
});
```

With one computer reachable, `computer` takes just the action. With several, it also takes a `sandbox` naming the computer, and every result says which screen it came from. Coordinates do not carry across screens, so the model should take a screenshot after switching. Approval follows the computer the call names, so a `bypass` machine clicks without asking while an `ask` machine still asks. Whether an agent can reach a computer at all is up to its owner starting the daemon with `--computer`.

## Local MCP servers

Start the daemon with `--mcp <file>` and the stdio MCP servers in that file run on your computer for your agents. The file uses the `.mcp.json` shape that Claude Code, Cursor and Codex read, so existing setups work as they are.

```json title=".mcp.json"
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

Register the server by naming the sandbox instead of a URL. The `name` is the `mcpServers` key:

```ts
export const blender = defineMcp({
  name: "blender",
  sandbox: myMac,
  allowedTools: ["get_scene_info", "execute_blender_code"],
});

export const designer = defineAgent({
  name: "designer",
  sandboxes: [myMac],
  mcp: { [blender.name]: { enabled: true, needsApproval: true } },
});
```

The daemon starts a server on its first call and keeps it running. The platform sees server names, tool listings and results, never the file or its commands. See [Tools](../tools.md) for MCP servers in general.

## Limits

- No workspaces. The file tools need the workspace mount, which a computer does not have. A run is refused when a workspace would inherit a machine, so give that workspace its own sandbox or `sandbox: null`. Use `bash` for files.
- No background jobs, snapshots, suspend or resume.
- The dashboard lists a connected computer under Sandboxes, Instances with its connection state, connect time, last seen time and the command that starts it. It has no size, image, trace or lifecycle controls.
