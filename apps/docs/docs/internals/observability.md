# Observability

This page covers the log and trace pipeline. It explains how every line is redacted, where it lands, how the dashboard and `broods logs` read it, and how sandbox output joins in. What users see is in the [observability guide](../guides/observability.md). Paths are relative to `apps/core/`.

## Pipeline

`emit()` in `src/shared/log.ts` is the one place every log line is redacted. It scrubs the message and data against the values of sensitive process env vars plus the run's own secret values, then writes to three sinks:

```mermaid
flowchart LR
  Call["logInfo / logWarn / logError / logDebug"] --> Redact["redact()"]
  Redact --> Stdout["stdout<br/>all levels"]
  Redact --> Otlp["OTLP exporter<br/>all levels, best-effort"]
  Redact --> Nats["NATS publish<br/>INFO, WARN, ERROR<br/>with an observability context"]
  Otlp -->|"/v1/logs"| Loki
  Otlp -->|"/v1/traces"| Tempo
  Nats --> Stream["OBSERVABILITY stream"]
  Stream --> Gateway["gateway<br/>replay + live relay"]
  Gateway --> Dash["dashboard Monitoring + Tracing<br/>broods logs / stream"]
  Loki -.->|"backfill"| Gateway
  Tempo -.->|"backfill"| Gateway
```

- stdout always gets every line, unmodified after redaction. It is the CloudWatch fallback and the source for metric filters.
- OTLP goes to `OTEL_EXPORTER_OTLP_ENDPOINT` and lands in Loki and Tempo, the long-term store. Gen-AI spans come from the AI SDK v7 `@ai-sdk/otel` integration, registered on the same tracer at init. Those spans do not record inputs or outputs, because the harness's own spans already carry the redacted payloads.
- NATS gets INFO, WARN and ERROR, never DEBUG, and only when an observability context is set. This is the live path. Channel and cron runs have no deployment-scoped context, so they skip NATS and still reach stdout and OTLP.

A failure in one sink never blocks the others and never throws into the agent path.

### User code

`console.*` inside a code hook runs in a V8 isolate with no logger of its own. The isolate sends each line back as a `log` frame on the NDJSON protocol that carries results, and the host re-emits it through `emit()` while it reads that run's frames. The line inherits the run's observability context and reaches all three sinks tagged `source: "user-code"`. Writing to stderr instead would lose it, because the pooled worker discards its children's stderr.

## Tenant scoping

Logs and spans carry the same attributes, so a span, its logs and the live stream correlate:

`account_id`, `project`, `stage`, `endpoint_id`, `agent_id`, `conversation_key`, `trace_id`

NATS subjects encode the routable subset (`src/shared/nats.ts`):

```text
v1.<accountId>.<project>.<base64url(stage)>.{logs|traces}.<endpointId>
```

The durable `OBSERVABILITY` JetStream stream binds `v1.*.*.*.logs.>` and `v1.*.*.*.traces.>`. It is file-backed and keeps 2 hours, at most 512 MiB and 20,000 messages per subject, set in `src/shared/nats.ts`. On subscribe the gateway replays the last 30 minutes of it before tailing live, per `OBS_REPLAY_WINDOW_MS` in `apps/gateway/src/observability.ts`. Like `WS_RESPONSES`, nothing purges it early. Messages expire by age and count. Loki and Tempo own everything older.

## The observability socket

The dashboard Monitoring and Tracing tabs and `broods logs`, `broods stream` and `broods dev` read through the gateway's observability socket. One `logs` subscribe, from `handleObservabilitySubscribe()` in `apps/gateway/src/observability.ts`:

```mermaid
sequenceDiagram
  participant C as dashboard or CLI
  participant G as gateway
  participant Core as core
  participant N as NATS OBSERVABILITY
  participant L as Loki

  C->>G: WS upgrade, fp_dts_ ticket
  G->>Core: /v1/internal/observability-scope
  Core-->>G: account, project, stage
  G->>G: refuse if the path's project or stage differ
  C->>G: subscribe logs, backfill: n
  G->>N: ordered consumer, last 30 minutes
  N-->>C: replayed lines, then live lines
  G-->>C: ready
  G->>L: stepped query, 1 h, then 1 day, then 30 days
  L-->>G: older lines
  G-->>C: closing backfill message, error set on failure
```

Traces take the same path, with a Tempo search in place of the Loki query.

- It refuses the stage runtime key. Clients connect with a fifteen-minute stage session ticket (`fp_dts_`), which the CLI mints from a login token at `POST /v1/account/stage-session` and refreshes before each reconnect.
- A `subscribe` with `backfill` always gets a closing `backfill` message, even when Loki or Tempo failed; that message then carries `error`, so a client can tell an empty stage from a failed query.
- Logs come back in one message. The Loki query widens in steps. It tries the last hour with a 5 s budget, then a day with 10 s, then 30 days with 15 s, stopping at the first step that fills a page. A step that times out ends the backfill, since a wider window only costs more. 30 days is Loki's own range cap.
- Traces come from a Tempo search over 7 days, Tempo's cap, with a 15 s budget. Each trace then needs its own lookup, with a 5 s budget and 6 at a time, so traces arrive newest first in chunks of 12 flagged `more: true`, and the closing message carries the failure count.
- `fetchTrace { traceId }` pulls one trace from Tempo for a log line older than the 7 day search window. Tempo's id lookup is not tenant-scoped, so the gateway filters the spans to the socket's account, project and stage before anything leaves. A lookup result is shared between sockets for 5 minutes.
- Backpressure. While a socket has more than 512 KiB unsent, live log and span messages to it are dropped rather than queued, and backfill waits up to 5 s for it to drain.
- Tempo truncates large attributes on ingest, so when the same span arrives from both NATS and Tempo, the dashboard keeps the richer or terminal copy.

## Traces

Every top-level run is its own trace, labelled by what started it. `task` is a request, `cron` a scheduled run, and `subtask` a subagent.

- The task span and every model step record `model.system`, the whole assembled prompt. That is the agent's prompt plus the memory index, workspace, memory, scheduler, skills and subagent harness blocks, skills loaded mid-run, persisted system context and steering. `model.system_part_count` and `model.system_chars` report the real size even when the payload is truncated.
- `agent.environment` is the live `<environment>` block, read at the start of the run. It holds the clock, where replies go, and each place `bash` can run, with whether a machine is connected. It is built from what the run already holds, with no extra storage read. The run sends it as its last message, after the history, and never stores it. The system prompt holds no clock, so the system prompt and the history stay a cached prefix and only this block changes from run to run.
- Each model step splits into time to first token, streaming, and tool wait. Streaming counts token generation only and never includes tool time. Tool wait also shows as child tool spans.
- A root that ends cleanly but leaves something open closes as `needs_input`, when it is blocked on the person (an open question or approval), or `waiting`, when work still has to settle (a subagent, an async tool, a background job). `task.waiting_on` says which one: `question`, `approval`, `subagent` or `tool`. OTel only has ok and error, so Tempo keeps the state in `task.state` and the gateway restores it on backfill.
- The Tracing tab lists one row per request, not per trace. The runs one request started nest under its first run: the passes that share its `task.id`, the runs an answer or finished job resumed (`task.root_id`), and its subagents (`parent.trace_id`). A wait row sits between a run that closed on something open and the next run. The row's status is the request's: Running, Waiting, Needs input, Done or Failed. A Done request with a subagent still running reads Waiting, and failed tool calls show as a count even when the run recovered.
- A failed `task` or `cron` root has a Continue button that posts `continue: true` for its agent and scoped conversation key.
- Config mutations write to Convex `configAuditEvents`, which the dashboard Settings Audit Logs tab reads.

## Sandbox output

Sandbox runs produce output in three places, and each takes a different road. Only the second is a log stream.

```mermaid
flowchart TD
  subgraph core["core"]
    Exec["sandbox tool result"] --> Span["tool.call span<br/>tool.output, 32k cap"]
    Life["reserve / exec / terminal / terminate"] --> Audit["Convex sandboxAuditEvents"]
  end
  Span --> Tempo2["Tempo + Tracing tab"]
  Audit --> Sheet["Instances sheet Activity"]

  subgraph microvm["lambda provider"]
    VM["guest stdout/stderr"] --> CW["CloudWatch<br/>/broods/stage/microvms"]
  end
  CW -->|"subscription filter"| Fwd["sandbox-log-forwarder"]
  Fwd -->|"OTLP"| Loki2["Loki"]

  subgraph workdir["sandbox provider host"]
    Sbx["sandboxd journald + firecracker.log"] --> Coll["host collector (pending #89)"]
  end
  Coll --> Ops["Grafana, operators only"]
```

1. Tool output on the trace, live on every provider. The harness does not log sandbox output. It puts the redacted result on the `tool.call` span as `tool.output`, capped at 32k characters. Lifecycle actions go to `sandboxAuditEvents`. The Logs tab sees almost none of this. `bash` logs one INFO line when a background job starts, the MicroVM and Daytona executors log a few warnings, and the `sandbox` provider's executor logs nothing. Output the guest writes with no tool call in front of it is not captured by this path.
2. MicroVM guest output, built. What the guest writes to stdout and stderr, such as the `/run` hook, background jobs and servers the agent started, goes to CloudWatch at `/broods/<stage>/microvms`, set by `MICROVM_LOG_GROUP_NAME`. Core names each stream `<accountId>/<project>/<stage>/<uuid>/<mac>` at launch and stores it on the instance row as `logStream`. A `-` segment marks a run with no deployment scope, such as a channel or cron run, which still ships for operators but never indexes as a tenant. The mac is an HMAC over the first four segments keyed by the `OTEL_EXPORTER_OTLP_HEADERS` line that core and the forwarder share. A guest can read the VM role from IMDS and create any stream in the group, so only a name core signed earns tenant labels. A forged one ships unlabeled. A CloudWatch subscription filter invokes `apps/lambda/sandbox-log-forwarder.mjs`, which verifies the name, sets `account_id`, `project` and `stage`, redacts, and posts one OTLP/HTTP request to the cluster collector, the only external write path into Loki. The VM id rides as `sandbox_id` structured metadata under service `broods-sandbox`, so an ephemeral VM never becomes a new Loki stream.
3. The `sandbox` provider's host, not built. `sandboxd` logs to journald and each VM keeps a Firecracker log, neither with a tenant. When the production host lands in #89, an otel-collector-contrib on the host will ship them as operator-only logs with `host`, `unit` and `sandbox_id` but no `account_id`, so they reach Grafana and never a customer dashboard.

The dashboard Instances sheet Logs tab and `broods logs --sandbox <uuid>` subscribe with `{ sandboxId }`. Sandbox lines never pass through NATS, so the gateway polls Loki every 2 s over a 3 minute lookback, at most 1,000 lines and 5 s per poll, newest first, dropping what it already relayed. The lookback is that wide because CloudWatch redelivery lands lines a minute or two late. Lines relay as opaque text under `eventType: "sandbox"`. The deployment stream's backfill excludes the bridge's service, so the Monitoring tab matches its live relay. Sandbox backfill reads one fixed day with a 15 s budget, not the stepped 30 days. The sandbox filter is structured metadata, so Loki scans every chunk of the tenant in the window, and a month took 8 s against 0.2 s for a day. A line reaches the screen 1 to 2 s after the collector accepts it, plus CloudWatch delivery time.

The forwarder and its filter are SST resources that deploy only when `OTEL_EXPORTER_OTLP_HEADERS` is set for the stage. It is the same `Authorization=Basic ...` line core ships with, so one credential serves both and rotates once.

## Runtime telemetry

Core writes compact JSON lines for metric-bearing events so CloudWatch Logs Insights, metric filters and dashboards can graph usage without parsing SSE.

| `eventType`                            | Carries                                                                                                                                  |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `model.step.finished`                  | Per-call `durationMs`, AI SDK `usage`, response id, model and timestamp, provider metadata, warning counts, tool call and result counts  |
| `model.invocation.finished`, `.failed` | Final status, whole-run `durationMs`, total `usage`, step count, tool call count, `toolsUsed`, per-tool `toolUsage`, compact `toolCalls` |
| `tool.call.finished`, `.failed`        | `toolName`, `toolCallId`, `durationMs`                                                                                                   |
| `model.step.warnings`                  | Provider warnings, such as an unsupported reasoning level                                                                                |

The common fields are `accountId`, `agentId`, `conversationKey`, `eventId`, `modelProvider`, `modelId`, `stepNumber`, `durationMs`.

A `tool.call` span for a tool that ran off-process carries `tool.compute.type` and `tool.compute.cpu_usec`. Sandbox execs report `sandbox`, from the host's cgroup, or `lambda`, from the image's `getrusage`. Hosted MCP calls report `mcp-sandbox`. Hosted MCP calls that shared one Lambda invoke each carry an even share of its CPU. The same samples are summed per task into `sandboxUsage` rows for usage metering. No such attributes means the call ran in-process or on a provider that reports no CPU.

Prompts, full tool inputs and outputs, request and response bodies, and response headers are not logged by default.

## Security

- One redaction chokepoint. `log.ts` redacts by key name, using exact, prefix and suffix deny lists with an allow list for known-safe keys, and scrubs every string against sensitive env values and the run's known secret values before any sink sees it. Pattern rules also catch `Bearer` and `Basic` values, query-string secrets, and `fp_agent_` and `fp_sts_` tokens.
- Scoped STS mount credentials are never logged. The MicroVM forwarder applies the pattern half of redaction, covering `Bearer` and `Basic` values, query-string secrets, and `fp_agent_` and `fp_sts_` tokens. It cannot know a run's own secret values. A guest that echoes an injected secret prints it to the owning account's view and to operators. Treat sandbox stdout as untrusted.
- A sandbox tail is scoped like every other observability socket. The gateway builds the Loki selector from the ticket's server-derived account, project and stage, and the client's `sandboxId` only narrows inside that. It must be the UUID shape core mints, or the wire rejects it before it reaches LogQL.

## Retention and follow-ups

- CloudWatch keeps the MicroVM group 30 days, Loki keeps 90. Once the bridge is verified on a stage, the group's retention can drop to a few days.
- The host collector for the `sandbox` provider belongs to that host's provisioning runbook in the infra repo, and waits for the production host in #89.
