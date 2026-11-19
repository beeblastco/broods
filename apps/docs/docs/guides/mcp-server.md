# Agents as MCP tools

Broods serves your agents on an MCP server at `/mcp`. A client such as Claude Code lists them, asks one, and gets its answer back.

```sh
claude mcp add --transport http broods https://gateway.broods.app/mcp
```

The client opens a browser to sign in with your Broods login, the same one as the dashboard. It needs the owner or admin role, like `broods login`. If you administer one organization, it acts as that one's account. With several, it acts as the one selected in the dashboard's organization switcher, so switching there repoints a client on the next request. To pin one, name it in the URL, `https://gateway.broods.app/mcp?org=<slug>`, which always wins. With several and none selected that you administer, the sign-in asks for `?org=`. A client without OAuth, or a script, sends a key instead:

```sh
claude mcp add --transport http broods https://gateway.broods.app/mcp \
  --header "Authorization: Bearer $BROODS_ACCOUNT_KEY"
```

The tools are the same for every account, however many agents it has:

| Tool           | Input                                        | Answer                                                                                         |
| -------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `list_agents`  | `project`, `stage`, both optional filters    | Each agent's name, description, project, stage and id                                          |
| `ask_agent`    | `agent`, `prompt`, optional `conversationId` | The agent's answer                                                                             |
| `get_run`      | `runId`                                      | A run's answer, its open question, or that it still works; no wait. For a client without tasks |
| `continue_run` | `runId`, optional `answers`                  | Waits for the rest of a run, or answers its question. For a client without tasks               |

`agent` is a name or an id from `list_agents`. A name that two agents share, such as the same agent in two stages, is refused with each one's id, project and stage, so pass the id. The calling model picks an agent by its description, so write one for each agent. An agent made through the account API, or one that runs in several stages, lists with no project or stage, and a `project` or `stage` filter leaves it out.

```json
{
  "agent": "support",
  "prompt": "Summarize yesterday's support tickets.",
  "conversationId": "optional, from an earlier answer, to continue it"
}
```

Every answer ends with its `conversationId`. Leave the field out to start fresh.

## How a call answers

A client with the `io.modelcontextprotocol/tasks` extension gets a task and polls it, as below. The task id is the run id, so the same run is also readable at `GET /v1/runs/{runId}`.

Any other client gets the answer directly, waiting up to 50 seconds. If the run needs longer, or the agent asks a question, the result says so and `continue_run` takes the `runId`, plus `answers` when there is a question.

Whether a tool call asks first is the agent's own config, the same as on every other surface: a sandbox with `permissionMode: "bypass"` runs everything without asking, and otherwise only the calls its mode or a tool's `needsApproval` gates wait. When one waits, a person approves it. A client without tasks is told what is waiting and cannot approve it itself.

## Which agents are listed

| Credential                          | Agents                                                              |
| ----------------------------------- | ------------------------------------------------------------------- |
| Account key (`bask_...`)            | Every agent in the account                                          |
| OAuth sign-in                       | Every agent in your organization's account (`?org=` picks one)      |
| Member's stage ticket (`bdts_...`)  | Every agent of that stage                                           |
| Runtime key (`bsk_...`)             | Public agents of its stage, with a user token where one is required |
| Run token, role session, scoped key | None                                                                |

The rules are the ones `POST /v1/runs` applies: an agent you can list is a run you can start, and plan limits count each `ask_agent` call as a run.

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
- `tasks/cancel` stops the run at its next model step. A task waiting on a form, or queued behind another run in the same conversation, has no live run, so it stays where it is and the other run keeps going.

How the translation works: [Tools and MCP internals](../internals/tools-and-mcp.md#mcp-tasks-server).
