# Your computer as a sandbox

The `machine` provider runs the agent's `bash` tool on your own computer. The agent stays in the cloud. Commands run as you, with your `PATH`, environment and installed tools. It can also give the agent your screen, mouse and keyboard, and run local MCP servers.

Your computer opens no port. `broods machine <sandbox>` holds one WebSocket to the gateway, and each command comes down it. When the daemon is not running, the tool call fails with the command that starts it.

Keep `permissionMode` on `ask`. With `bypass` the agent runs any command on your computer without asking.

To let agents act in the browser of each person who uses your app, rather than on one computer, see [Browsers (scope: user)](#browsers-scope-user).

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

`persistent`, `size` and `snapshot` are rejected, and `network.mode` must be `allow-all`.

The daemon strips every `BROODS_*` variable from the environment of agent commands and MCP servers, so an agent shell cannot read `BROODS_API_KEY` or `BROODS_TOKEN`.

## Run the daemon

```bash
broods machine my-mac
broods machine my-mac --cwd ~/Projects/app
```

It needs a `broods login` and a deployed stage, like `broods logs`. The daemon trades your login for a fifteen-minute stage ticket and hands core a fresh one on the open socket before it expires, so a long command is never cut off by the ticket; each reconnect mints a fresh one too. The machine socket also accepts an account key or a [role session](../security.md), which needs `sandboxes:write` on the sandbox. It never accepts the runtime key, which is meant for frontends.

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
- `screenshot`, `zoom`, `cursor_position` and `wait` never ask for approval on their own. Every other action asks unless `permissionMode` is `bypass`.
- Actions run in the order the model gave them. One that comes after an action waiting for approval in the same step never runs ahead of it: it is asked for in the same round, even a screenshot, and runs after that action, so it sees its result.
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

Start the daemon with `--mcp <file>` and the stdio MCP servers in that file run on your computer for your agents. The file uses the `.mcp.json` shape that Claude Code, Cursor and Codex read. Each server must speak MCP 2026-07-28: a server built on a 2025-era SDK is refused when the daemon first starts it, with an error naming the version. Starting a server also runs its command once more, briefly, to ask which version it speaks.

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

## Browsers (scope: user)

With `scope: "user"` a machine sandbox is no longer one computer. It is the browser of each signed-in person of your own app. Each person runs your Chrome extension, the extension holds its own socket, and a run started with that person's [user token](../security.md#users-behind-the-runtime-key) can read and act on their page through the `browser` tool. A run can only ever reach the browser of the person it belongs to.

```ts title="broods/index.ts"
export const web = defineSandbox({
  name: "web",
  provider: "machine",
  permissionMode: "ask",
  network: { mode: "allow-all" },
  options: {
    scope: "user",
    allowedExtensionIds: ["abcdefghijklmnopabcdefghijklmnop"], // your extension's id
    allowedDomains: ["example.com", "*.example.com"], // optional
  },
});

export const assistant = defineAgent({
  name: "assistant",
  sandboxes: [web],
});
```

Your backend signs a browser ticket for the signed-in person, with the same signing secret as their user tokens (`BROODS_USER_TOKEN_SECRET`):

```ts title="your backend"
import { signBrowserTicket } from "broods";

// after your own sign-in check
const ticket = await signBrowserTicket({ userId: user.id, sandbox: "web" });
```

The extension connects with the SDK's browser client. It has no dependencies, so a Manifest V3 service worker bundles it as is. The socket URL names the project and stage ids, which `broods dev` and `broods deploy` write to `api.stage` in `broods/_generated/api.ts`:

```ts title="extension service worker"
import { browserSocketUrl, connectBrowser } from "broods";

const stage = { projectId: "k57…", stageId: "k98…" }; // api.stage

connectBrowser({
  url: browserSocketUrl({ baseUrl: "https://gateway.broods.app", ...stage }),
  getTicket: () =>
    fetch("https://app.example.com/broods/ticket", {
      credentials: "include",
    }).then((r) => r.text()),
  sandbox: "web",
  instance: crypto.randomUUID(),
  onAction: async (action) => runOnActiveTab(action), // your code: returns { text }, { image } or { error }
});
```

| Action        | Fields                   | Asks for approval |
| ------------- | ------------------------ | ----------------- |
| `read_page`   |                          | no                |
| `screenshot`  |                          | no                |
| `click`       | `ref`                    | yes               |
| `fill`        | `fields: [{ref, value}]` | yes               |
| `type`        | `text`                   | yes               |
| `press_key`   | `key`                    | yes               |
| `navigate`    | `url`                    | yes               |
| `upload_file` | `ref`, `url`, `name`     | yes               |

`read_page` answers with the page as text and a `ref` for each element the agent can act on. Refs are your extension's own strings; Broods passes them back unchanged. An action that asks runs without asking when `permissionMode` is `bypass`.

### Security model

- **One user, one browser.** Which browser a call reaches is the run's end user, from the verified user token. The model cannot name another one. A run without a user token, a cron run, and a run started with the account key reach no browser, and the tool says so. Subagents keep their parent's end user.
- **Tickets.** A `bbt_` ticket names one user and one sandbox and lives at most 15 minutes (10 by default). It opens one socket, or one refresh, once. A user token never opens a socket and a ticket never starts a run, though one secret signs both. Rotating the secret closes every browser within a minute.
- **Origin.** The socket opens only from `chrome-extension://<id>` with an id in `allowedExtensionIds`. A web page, another extension, or a request with no Origin is refused. A native program can forge an Origin, so the ticket is what keeps strangers out: sign one only for a person your backend signed in.
- **Where it may go.** `navigate` and `upload_file` take `https` URLs only, never `chrome:`, `file:`, `javascript:` or `data:`, and only hosts in `allowedDomains` when it is set. `example.com` matches that host; `*.example.com` its subdomains. Broods checks before it sends; check again in the extension, because a click can still follow a link.
- **Page content is data.** The tool tells the model that page text and screenshots are not instructions, and to ask before passwords, payments or CAPTCHAs. Page text is cut at 256 KB and a screenshot must be png, jpeg or webp of at most 3 MB.
- **Pace.** One action runs at a time per browser, in the model's order, and at most 20 a second.

A browser sandbox runs no `bash`, no computer tool and no local MCP server, and `broods machine` cannot claim it. The same person's newer socket replaces the older one (close code `4409`), and the client stops there rather than fight it. Close codes `4400`, `4403` and `4404` stop the client too; anything else reconnects with a fresh ticket.

## Limits

- No workspaces. The file tools need the workspace mount, which a computer does not have. A run is refused when a workspace would inherit a machine, so give that workspace its own sandbox or `sandbox: null`. Use `bash` for files.
- No background jobs, snapshots, suspend or resume.
- The dashboard does not list connected browsers of a `scope: "user"` sandbox yet.
- The dashboard lists a connected computer under Sandboxes, Instances with its connection state, size, connect time, last seen time and the command that starts it. The size is the CPU count, memory and home disk the daemon reports when it connects; a daemon from an older CLI reports none, and the size shows `?` until you update and restart it. It has no image, trace or lifecycle controls.
