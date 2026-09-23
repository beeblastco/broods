# Tools

An agent gets tools from four places:

| Source                | How you enable it                | Examples                                                    |
| --------------------- | -------------------------------- | ----------------------------------------------------------- |
| Your model provider   | `tools` on the agent             | `googleSearch`, OpenAI `webSearch`, Anthropic `computerUse` |
| MCP servers           | `defineMcp` + `mcp` on the agent | Any MCP server, yours or a vendor's                         |
| Sandboxes, workspaces | `sandboxes`, `workspaces`        | `bash`, `read`, `write`, `edit`, `glob`, `grep`             |
| Broods features       | the matching agent setting       | `load_skill`, `run_subagent`, `schedule`, `ask_questions`   |

This page covers the first two, approvals, and the built-in tools. Sandbox tools are in [Sandboxes](sandboxes/index.md).

## Provider tools

Import the tool from the provider's AI SDK package and pass it in, keyed by the name the provider uses:

```ts title="broods/index.ts"
import { google } from "@ai-sdk/google";
import { defineAgent, env } from "broods";

export const researcher = defineAgent({
  name: "researcher",
  provider: { google: { apiKey: env("GOOGLE_API_KEY") } },
  model: { provider: "google", modelId: "gemini-3-flash" },
  tools: {
    googleSearch: google.tools.googleSearch({ searchTypes: { webSearch: {} } }),
    urlContext: { ...google.tools.urlContext({}), needsApproval: true },
  },
});
```

The provider runs these tools itself during the model call. Available names depend on `model.provider`: Google has `googleSearch`, `urlContext`, `googleMaps`, `codeExecution`, `fileSearch` and `enterpriseWebSearch`. OpenAI has `webSearch`, `codeInterpreter` and `fileSearch`. Anthropic has `computerUse`, `bash`, `textEditor` and `webSearch`. A name the provider does not have fails the run and lists the names it does have.

A tool that your code would execute, such as the Tavily AI SDK package, cannot go in `tools`, because a function does not survive sync. Put it behind an MCP server.

## MCP servers

Broods connects to any MCP server that speaks the stateless Streamable HTTP transport. Tools show up as `<server>__<tool>`, for example `search__query`.

### Connect a server

```ts title="broods/index.ts"
import { defineAgent, defineMcp } from "broods";

export const search = defineMcp({
  name: "search",
  url: "https://mcp.example.com/mcp",
  headers: { Authorization: "Bearer ${SEARCH_TOKEN}" },
  allowedTools: ["query"], // optional, omit to allow all
});

export const agent = defineAgent({
  name: "assistant",
  mcp: { [search.name]: { enabled: true, needsApproval: false } },
});
```

Rules:

- `name` is 1 to 32 lowercase letters, digits or hyphens, unique per stage.
- The URL must be public. Private, loopback, link-local and metadata addresses are refused, and so are redirects. For a server on `localhost` or your network, run it on your computer with the [machine sandbox](sandboxes/machine.md).
- Credential headers such as `Authorization` or `X-Api-Key` must name an environment variable inside a plain string, `"Bearer ${SEARCH_TOKEN}"`. Inline secrets are rejected. A template literal around `env()` sends `[object Object]`.
- Tool lists are cached for the time the server's listing allows. Server-pushed list changes are not supported.

### Servers with expiring OAuth tokens

Some servers, such as Google's Workspace MCP endpoints, only accept short-lived access tokens. Give `oauth` instead of an Authorization header, and Broods mints, caches and refreshes the tokens:

```ts
export const gmail = defineMcp({
  name: "gmail",
  url: "https://gmailmcp.googleapis.com/mcp/v1",
  oauth: {
    clientId: "1234.apps.googleusercontent.com",
    clientSecret: env("GMAIL_CLIENT_SECRET"),
    refreshToken: env("GMAIL_REFRESH_TOKEN"),
    // tokenUrl defaults to https://oauth2.googleapis.com/token
  },
});

export const assistant = defineAgent({
  name: "assistant",
  mcp: {
    [gmail.name]: {
      enabled: true,
      // repeat the secrets so they resolve into the agent's encrypted config
      oauth: {
        clientSecret: env("GMAIL_CLIENT_SECRET"),
        refreshToken: env("GMAIL_REFRESH_TOKEN"),
      },
    },
  },
});
```

Both the server URL and `tokenUrl` must be `https`.

### Host your own server on Broods

Write the server in the same file and Broods runs it for you:

```ts
import { defineMcp } from "broods";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";

export const greeter = defineMcp({
  name: "greeter",
  handler: createMcpHandler(() => {
    const server = new McpServer({ name: "greeter", version: "1.0.0" });
    // server.registerTool(...)
    return server;
  }),
});
```

Install `@modelcontextprotocol/server` in your project. The CLI bundles the file, checks that the handler loads, and uploads it on sync.

- The factory must build a new server on every call. Calls from one model step run at the same time, and a shared instance breaks.
- Bundles are capped at 50 MB. Each call has a 30 second deadline and 16 MB of output.
- Hosted servers run isolated per account. The first call after an idle period is a cold start.
- Module-level state, such as a memoized client, survives between calls of the same bundle.

See the runnable [`mcp-connect` demo](https://github.com/beeblastco/broods/tree/dev/packages/demos/mcp-connect).

### Run a server on your computer

A server in your `.mcp.json`, such as a Blender or filesystem server, can run on your machine and serve cloud agents. Name the machine sandbox instead of a URL. See [Machine](sandboxes/machine.md).

## Approvals

`needsApproval: true` on a provider tool or an MCP entry pauses the run before the tool executes. Sandbox tools follow the sandbox `permissionMode` instead.

| Where the run came from | What happens                                                                      |
| ----------------------- | --------------------------------------------------------------------------------- |
| SSE or `broods run`     | The stream sends an approval request. Resume with a `tool-approval-response`.     |
| Background run          | Status becomes `awaiting_approval` with an `approvals` list.                      |
| Channel                 | The tool is denied with "Tool approval is only supported through the direct API." |

Keep approval off for agents that only live in channels. Subagents that inherit a parent with approval on currently fail, so turn approval off on the parent's tools when you use subagents.

## Asking the user

`ask_questions` lets the agent ask one to three multiple-choice questions and keep working. It is on automatically for channel, WebSocket and direct runs. Cron runs and subagents do not get it.

Each question has an `id`, a short `header`, the `question`, two to four `options`, and optionally `allowFreeText`. With `blocking: false` (the default) the agent keeps working and the answer arrives later. With `blocking: true` the turn ends and the answer resumes it. Unanswered questions expire after `timeoutSeconds`, one day by default, between 30 seconds and 7 days.

| Where       | The question appears as                  | The user answers by                                                                            |
| ----------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Telegram    | inline buttons                           | tapping a button                                                                               |
| Other chats | numbered text                            | replying with the number, the label, or free text. The reply answers the oldest open question. |
| HTTP        | status `awaiting_input` with `questions` | posting `answers: [{ statusId, answers: { <id>: [labels] } }]` to `/v1/runs` with no `events`  |
| WebSocket   | a `question-request` frame               | an `execute` frame carrying `answers`                                                          |

## Background tools

`async_status` appears on its own when the agent can start background work: a workspace on a persistent sandbox, or a tool marked `async: true`. The model uses it to check, tail or stop that work. See [Persistent sandboxes](sandboxes/persistent.md).

## Other built-in tools

| Tool                                                                      | Enabled by                          | Guide                                         |
| ------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------- |
| `load_skill`                                                              | `skills`                            | [Skills](skills.md)                           |
| `run_subagent`, `get_subagent_status`, `update_subagent`, `stop_subagent` | `subagent`                          | [Subagents](subagents.md)                     |
| `schedule`, `list_schedules`, `update_schedule`, `cancel_schedule`        | `scheduler`                         | [Scheduling](scheduling.md)                   |
| `memory_save`                                                             | a workspace with a sandbox          | [Memory and sessions](memory-and-sessions.md) |
| `send-message`, `send-images`, `send-files`, `send-update`, ...           | channel turns                       | [Channels](../channels/index.md)              |
| `computer`                                                                | a machine sandbox with `--computer` | [Machine](sandboxes/machine.md)               |

Withhold any tool in one channel with `denyTools` on its [channel record](../channels/channel-records.md), or everywhere with a [policy](policies.md).
