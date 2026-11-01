# Observability

Every run produces logs and a trace. You read them in the dashboard or the terminal.

## In the dashboard

| Tab        | Shows                                                                                                                                    |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Monitoring | Log lines for the stage, live and history, filterable by level                                                                           |
| Tracing    | Every run as a trace, with the full system prompt, tools offered, model input, reasoning, response, each tool call with input and output |
| Instances  | Sandbox instances, their activity, a terminal, and a Logs tab with the guest's own output for `lambda` sandboxes                         |
| Settings   | Audit log of config changes, webhooks                                                                                                    |

Each run carries a label for what started it, `task` for a request, `cron` for a scheduled run, `subtask` for a subagent. A run's rows read as lines: each model step, then its reasoning, its tool calls with their first argument, and its answer, each opening inline on its text. Each model step is split into time to first token, streaming, and tool wait, so a slow tool never looks like slow generation. A failed `task` or `cron` run has a Continue button. See [Conversations](conversations.md).

A subagent is its own run. It lists under the request that started it, at any depth, behind the avatar stack at the end of the request's row, and the request's trace shows it as one line that opens it. The run's header then carries the chain back to the request.

To hand a run to your own coding agent, such as Claude Code, open it in Tracing and click **Copy prompt for agent**. The prompt carries the dashboard, project, stage, agent, task id, trace id (plus the trace ids of the task's other runs), conversation and the run's error quoted as data, and tells the agent to read the run with `broods trace <trace-id> --json` under its own `broods login`, find the root cause, and fix or audit the agent. Besides the ids it holds only the run's own error, which Broods redacts before recording it, never prompts, tool data or keys. The short trace id beside it copies the full id.

The system prompt shown on a trace is the whole assembled prompt, meaning your `agent.system` plus memory, workspace, skills, subagent and scheduler blocks, and any steering. Large payloads are truncated, but the recorded size is always real.

Members and admins can both read logs and traces. See [Security](security.md).

The search, range and selected run are in the page URL, so a link opens the same view.

## In the terminal

```bash
broods stream                    # live warnings and errors
broods logs --limit 100          # recent history, then live
broods logs --level info         # INFO and above
broods logs --all                # every level. DEBUG only appears in history.
broods logs --json               # one JSON object per line
broods logs --sandbox <uuid>     # one lambda sandbox's guest output
broods trace <trace-id> --json   # one run's every span, then exit
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

The dashboard replays roughly the last two hours instantly on connect. Older logs and traces load from long-term storage when you page back. Traces are kept 30 days. The Tracing tab lists the last seven days, and an older trace opens by id, such as from a Usage chart bin. Usage totals and cost outlive their traces.

For your own pipeline, send [webhooks](webhooks.md) to a service you run. [Observability internals](../internals/observability.md) explains how the pipeline works inside.
