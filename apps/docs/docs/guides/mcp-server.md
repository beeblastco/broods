# Agents as MCP tools

Broods serves your agents as tools on an MCP server at `/mcp`. A client such as Claude Code calls an agent like any other tool and gets a task back, then polls it until the agent answers.

```sh
claude mcp add --transport http broods https://gateway.broods.app/mcp \
  --header "Authorization: Bearer $BROODS_ACCOUNT_KEY"
```

Each agent the key can run is one tool. The tool name is the agent id, its title is the agent's name, and its description is the agent's description, so write one the calling model can pick from. The input is one field:

```json
{ "prompt": "Summarize yesterday's support tickets." }
```

Every call starts a background run in a fresh conversation. The task id is the run id, so the same run is also readable at `GET /v1/runs/{runId}`.

## Which agents are listed

| Credential                          | Tools                                                               |
| ----------------------------------- | ------------------------------------------------------------------- |
| Account key (`bask_...`)            | Every agent in the account                                          |
| Member's stage ticket (`bdts_...`)  | Every agent of that stage                                           |
| Runtime key (`bsk_...`)             | Public agents of its stage, with a user token where one is required |
| Run token, role session, scoped key | None                                                                |

The rules are the ones `POST /v1/runs` applies: a tool you can see is a run you can start, and plan limits count each call as a run.

## Task states

| Run status                             | Task                                                            |
| -------------------------------------- | --------------------------------------------------------------- |
| `accepted`, `queued`, `processing`     | `working`                                                       |
| `awaiting_input`                       | `input_required`, one form per open question, options as a list |
| `awaiting_approval`                    | `input_required`, one "Allow tool?" checkbox per tool call      |
| `completed`                            | `completed`, the agent's final text as the tool result          |
| `failed`, `expired`                    | `completed` with `isError: true` and the error as text          |
| Stopped with `tasks/cancel` or `/stop` | `cancelled`                                                     |

Answer a form with `tasks/update`. A question answered with `decline` or `cancel` reaches the agent as "The user declined to answer." An approval is allowed only when its checkbox is accepted as true; anything else denies it.

## Gotchas

- The client must declare the `io.modelcontextprotocol/tasks` extension on each request. Without it a tool call answers `-32021`.
- The server speaks MCP revision 2026-07-28 only. A 2025-era client that opens with `initialize` gets `-32022`.
- Answer every approval of a task in one `tasks/update`. A partial set is held back until the rest arrive.
- `tasks/cancel` stops the run at its next model step. A task waiting on a form has no live run, so it stays waiting; answer it or leave it to expire.
- Each call is a new conversation. To keep context across calls, use [conversations](conversations.md) on `/v1/runs` instead.

How the translation works: [Tools and MCP internals](../internals/tools-and-mcp.md#mcp-tasks-server).
