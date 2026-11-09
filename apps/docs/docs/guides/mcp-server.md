# Agents as MCP tools

Broods serves your agents as tools on an MCP server at `/mcp`. A client such as Claude Code calls an agent like any other tool and gets its answer back.

```sh
claude mcp add --transport http broods https://gateway.broods.app/mcp
```

The client opens a browser to sign in with your Broods login, the same one as the dashboard. It needs the owner or admin role, like `broods login`, and acts as your active organization's account. A client without OAuth, or a script, sends a key instead:

```sh
claude mcp add --transport http broods https://gateway.broods.app/mcp \
  --header "Authorization: Bearer $BROODS_ACCOUNT_KEY"
```

Each agent the key can run is one tool, named after the agent. Its description is the agent's description, so write one the calling model can pick from. Agents that share a name across an account's stages get the end of their id added. The input:

```json
{
  "prompt": "Summarize yesterday's support tickets.",
  "conversationId": "optional, from an earlier answer, to continue it"
}
```

Every answer ends with its `conversationId`. Leave the field out to start fresh.

## How a call answers

A client with the `io.modelcontextprotocol/tasks` extension gets a task and polls it, as below. The task id is the run id, so the same run is also readable at `GET /v1/runs/{runId}`.

Any other client gets the answer directly, waiting up to 50 seconds. If the run needs longer, or the agent asks a question, the result says so and the extra `continue_run` tool takes the `runId`, plus `answers` when there is a question.

Whether a tool call asks first is the agent's own config, the same as on every other surface: a sandbox with `permissionMode: "bypass"` runs everything without asking, and otherwise only the calls its mode or a tool's `needsApproval` gates wait. When one waits, a person approves it. A client without tasks is told what is waiting and cannot approve it itself.

## Which agents are listed

| Credential                          | Tools                                                               |
| ----------------------------------- | ------------------------------------------------------------------- |
| Account key (`bask_...`)            | Every agent in the account                                          |
| OAuth sign-in                       | Every agent in your active organization's account                   |
| Member's stage ticket (`bdts_...`)  | Every agent of that stage                                           |
| Runtime key (`bsk_...`)             | Public agents of its stage, with a user token where one is required |
| Run token, role session, scoped key | None                                                                |

The rules are the ones `POST /v1/runs` applies: a tool you can see is a run you can start, and plan limits count each call as a run.

## Task states

These apply to clients with the tasks extension.

| Run status                             | Task                                                               |
| -------------------------------------- | ------------------------------------------------------------------ |
| `accepted`, `queued`, `processing`     | `working`                                                          |
| `awaiting_input`                       | `input_required`, one form per open question, options as a list    |
| `awaiting_approval`                    | `input_required`, one form with an "Allow?" checkbox per tool call |
| `completed`                            | `completed`, the agent's final text as the tool result             |
| `failed`, `expired`                    | `completed` with `isError: true` and the error as text             |
| Stopped with `tasks/cancel` or `/stop` | `cancelled`                                                        |

Answer a form with `tasks/update`. A question answered with `decline` or `cancel` reaches the agent as "The user declined to answer." An approval is allowed only when its checkbox is accepted as true; anything else, including declining the form, denies it.

## Gotchas

- `tasks/get`, `tasks/update` and `tasks/cancel` need the tasks extension on each request. Without it they answer `-32021`.
- The server speaks MCP revision 2026-07-28 only. A 2025-era client that opens with `initialize` gets `-32022`.
- `tasks/cancel` stops the run at its next model step. A task waiting on a form has no live run, so it stays waiting; answer it or leave it to expire.

How the translation works: [Tools and MCP internals](../internals/tools-and-mcp.md#mcp-tasks-server).
