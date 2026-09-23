# Persistent sandboxes

By default a sandbox is ephemeral. Each call creates a machine, runs, and destroys it. Only workspace files survive. Set `persistent: true` to reserve a long-lived machine instead, so installed packages, code on local disk and running processes survive between calls. It scales down when idle and wakes on the next call.

```ts title="broods/index.ts"
import { defineSandbox } from "broods";

export const devBox = defineSandbox({
  name: "dev-box",
  provider: "sandbox",
  network: { mode: "allow-all" },
  permissionMode: "bypass",
  persistent: true,
  lifecycle: {
    idleTimeoutSeconds: 1800, // scale down after 30 min idle, default 900
    maxLifetimeSeconds: 86400, // rebuild once a day, optional
  },
  onCreate: ["python3 -m venv $HOME/.venv"],
  onResume: ["test -x $HOME/.venv/bin/python"],
});
```

## When to use it

Stay ephemeral unless the agent needs state between calls. Ephemeral runs hold resources only for the seconds a command runs, and there is nothing to leak. Give an ephemeral sandbox a `fallbackProvider` so a full provider hands the run to a second one instead of failing the tool call.

Reserve a machine for iterative coding sessions, long-running work, background jobs, or when you want the live terminal in the dashboard. Avoid it for one-shot tasks.

On `lambda`, a reserved MicroVM counts against your account's allocated memory quota while it runs and while it is suspended. A handful of persistent agents can exhaust the quota, and every new launch then fails with `ServiceQuotaExceededException` and the message "maximum allocated memory limit". Terminate reservations you are done with from the dashboard, under Sandbox, Instances. That frees the quota at once instead of waiting for the idle window.

## Which machine you get

A persistent sandbox reserves one machine per workspace that mounts it. A persistent sandbox the agent uses without a workspace reserves one machine per agent and sandbox. Pointing the agent at a different sandbox record gives it that record's machine.

Set `options.reservationKey` to choose the reservation yourself. Two sandboxes with the same key share one machine, which is how several agents deliberately work on one box. Keys are scoped to your account, so the same string on another account names a different machine.

Only the workspace mount outlives the reservation. When a reservation ends, local disk is gone.

## Idle and lifetime

| Provider  | On idle                                    | Resume           | Limits                                                |
| --------- | ------------------------------------------ | ---------------- | ----------------------------------------------------- |
| `sandbox` | pause and standby                          | on the next exec |                                                       |
| `lambda`  | suspended to a snapshot of memory and disk | 1 to 10 s        | a MicroVM lives at most 8 hours, then it is recreated |
| `daytona` | stopped via `autoStopInterval`, disk kept  | on the next call |                                                       |
| `e2b`     | paused, files, installs and processes kept | on the next call |                                                       |
| `vercel`  | stopped, filesystem kept                   | on the next call | the timeout counts from start, not from last activity |

`idleTimeoutSeconds` defaults to 900 and can be at most 7 days. `maxLifetimeSeconds` is an optional ceiling on age since creation, at most 30 days. It is checked when a call acquires the machine, so it never interrupts a running command; the call that trips it boots a fresh machine. Vercel does not enforce `maxLifetimeSeconds`, and its idle timeout stops the sandbox that many seconds after each wake, even mid-activity.

Idle scale-down never pauses a machine while a background job runs.

## Setup commands

`onCreate` runs once, when the machine is first reserved. `onResume` runs when it is acquired again. Both need `persistent: true`.

| Provider                       | When `onResume` runs                         |
| ------------------------------ | -------------------------------------------- |
| `sandbox`, `daytona`, `lambda` | on every call                                |
| `vercel`                       | only when a stopped sandbox resumes          |
| `e2b`                          | not supported. Put setup in the E2B template |

Make `onResume` idempotent, since on most providers it runs every time.

## Background jobs

On a persistent sandbox `bash` accepts `background: true`. The command starts as a detached job and the tool returns a `statusId` at once:

```text
bash          { command: "uv run train.py", background: true }  → statusId
async_status  { statusId }                    → running, completed with logs, or failed
async_status  { statusId, action: "logs" }    → tail the output
async_status  { statusId, action: "stop" }    → stop the job
```

When the job exits it reports back, the conversation resumes with the result, and the follow-up goes to wherever the turn came from:

| Turn came from      | Result delivered                                                        |
| ------------------- | ----------------------------------------------------------------------- |
| A chat channel      | posted into the same chat                                               |
| WebSocket           | published to the conversation stream, replayed on reconnect             |
| Direct or async API | settled on the run status, and lifecycle webhooks fire `agent.finished` |

The model does not have to poll, though it can. `async_status` is added automatically when the agent has a workspace on a persistent sandbox. A persistent sandbox used with no workspace does not get it.

- Auto-delivery needs the sandbox to reach the Broods gateway, so use `network.mode: "allow-all"` or allow that host. Without egress the job still runs and `async_status` polling still works.
- `logs` and `stop` exist only where the provider exposes live job control. E2B launches jobs natively and offers `status` only.
- `sandbox`, `daytona` and `vercel` run at most 10 background jobs at once.
- A job killed because its machine was recreated reports `failed`, never "running forever".
- No account secret enters the sandbox. The job reports back with a short-lived token of its own.
- Discord delivers a late reply with the bot token, so the bot needs the Send Messages permission in that channel.

## Terminals

`bash` with `pty: true` gives the agent a real terminal for programs that need one. It works on every provider. See [What the model sees](index.md#what-the-model-sees).

The dashboard gives you a live terminal on `sandbox` and `lambda` instances, under Sandbox, Instances. It is a real TTY, and connecting resumes a suspended instance. Other providers get a command runner capped at 30 seconds and 64 KiB per command. A `lambda` reservation made before terminals shipped has to be terminated and reserved again once to get one; the API answers `409` with that hint.

## Cleanup

- Deleting a workspace or the account tears down its reserved machines.
- A reservation that has not been used for 7 days expires, and the machine is deleted at its provider.
- Terminate a reservation from the dashboard to free it immediately.

See [Providers](providers.md) for per-provider details and [Sandbox internals](../../internals/sandboxes.md) for how reservations are tracked.
