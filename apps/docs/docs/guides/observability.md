# Observability

Every run produces logs and a trace. You read them in the dashboard or the terminal.

## In the dashboard

| Tab        | Shows                                                                                                                                    |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Monitoring | Log lines for the stage, live and history, filterable by level                                                                           |
| Tracing    | Every run as a trace, with the full system prompt, tools offered, model input, reasoning, response, each tool call with input and output |
| Instances  | Sandbox instances, their activity, a terminal, and a Logs tab with the guest's own output for `lambda` sandboxes                         |
| Settings   | Audit log of config changes, webhooks                                                                                                    |

Each run carries a label for what started it, `task` for a request, `cron` for a scheduled run, `subtask` for a subagent. Each model step is split into time to first token, streaming, and tool wait, so a slow tool never looks like slow generation. A failed `task` or `cron` run has a Continue button. See [Conversations](conversations.md).

The system prompt shown on a trace is the whole assembled prompt, meaning your `agent.system` plus memory, workspace, skills, subagent and scheduler blocks, and any steering. Large payloads are truncated, but the recorded size is always real.

Members and admins can both read logs and traces. See [Security](security.md).

## In the terminal

```bash
broods stream                    # live warnings and errors
broods logs --limit 100          # recent history, then live
broods logs --level info         # INFO and above
broods logs --all                # every level. DEBUG only appears in history.
broods logs --json               # one JSON object per line
broods logs --sandbox <uuid>     # one lambda sandbox's guest output
```

`broods dev` also tails warnings and errors while it watches. These commands need `broods login`. They trade your login for a 15-minute stage ticket and renew it on reconnect. The runtime key in `BROODS_API_KEY` cannot open logs, because logs contain every end user's messages and tool data.

## What gets logged

- Log lines carry `account_id`, `project`, `stage`, `agent_id`, `conversation_key` and `trace_id`, so a line links to its trace.
- Broods redacts secrets before anything is written, by field name and by matching the run's known secret values.
- `console.*` in a [code hook](hooks.md) appears tagged `source: "user-code"`.
- Tool output from a sandbox is recorded on the tool's trace span, up to 32,000 characters. It does not appear as log lines.
- For `lambda` sandboxes, what the guest itself prints, such as background jobs and servers, ships to the Instances Logs tab within a few seconds. Treat it as untrusted. A program that prints an injected secret prints it there.
- Prompts, tool inputs and outputs are not written to plain logs. They live on traces.

## Retention

The dashboard replays roughly the last two hours instantly on connect. Older logs and traces load from long-term storage when you page back. Traces older than the seven-day search window can still be opened by id.

For your own pipeline, send [webhooks](webhooks.md) to a service you run. [Observability internals](../internals/observability.md) explains how the pipeline works inside.
