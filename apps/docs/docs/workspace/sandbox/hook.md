# Hooks

A sandbox has two hook surfaces today, plus a planned one. Keep them distinct:

| Hook surface | What it is | Where it runs |
| --- | --- | --- |
| **Setup commands** (`onCreate`/`onResume`) | shell commands you declare on a persistent config | inside the sandbox, on create/resume |
| **Runtime lifecycle hooks** | image-implemented HTTP endpoints the platform calls | inside the image (internal) |
| **User code hooks** (planned, [#63](https://github.com/beeblastco/broods/issues/63)) | uploaded TS that runs around agent/channel events | egress-less V8 isolate — **not shipped yet** |

These are **different from [agent Lifecycle Webhooks](../../webhook.md)**, which deliver
signed HTTPS event JSON to an external endpoint and do not execute any code in the sandbox.

## Setup commands (`onCreate` / `onResume`)

On a [persistent](best-practice.md#reserved-persistent-sandboxes) config you can declare
shell commands that run when the reserved sandbox is created or re-acquired — typically to
build a virtualenv or install dependencies that then survive across calls:

```jsonc
{
  "config": {
    "provider": "sandbox",
    "persistent": true,
    "onCreate": ["python3 -m venv $HOME/.venv"],
    "onResume": ["test -x $HOME/.venv/bin/python"]
  }
}
```

- `onCreate` runs **once**, when the sandbox is first reserved.
- `onResume` runs when the sandbox is re-acquired. Provider timing differs:
  - `sandbox` (workdir), `daytona`, and `e2b` run `onResume` on **every call** (they can't
    distinguish a fresh reconnect from a resume) — make `onResume` idempotent.
  - `vercel` fires `onResume` **only when a stopped sandbox actually resumes**.
- These hooks are **only honored on persistent configs**. `e2b` does not accept
  `onCreate`/`onResume` at all — put setup in the E2B template instead.

## Runtime lifecycle hooks (`lambda` MicroVM)

The MicroVM image implements HTTP lifecycle hooks the platform calls at VM transitions
(under `/aws/lambda-microvms/runtime/v1/<hook>`). These are **internal to the image**, not
something account config declares — they are what makes the workspace mount and
suspend/resume work:

| Hook | When | What the image does |
| --- | --- | --- |
| `/ready`, `/validate` | image build | health / validation (return 200) |
| `/run` | per VM start | `mount-s3` the workspace from the run-hook payload |
| `/resume` | on resume from suspend | reconnect / refresh credentials |
| `/suspend` | before snapshot | `sync(2)` flush |
| `/terminate` | on teardown | unmount + final `sync` |

The self-hosted `sandbox` (workdir) backend performs the equivalent mount/flush work
through its own pause/resume lifecycle. See [Lambda → Lifecycle hooks](lambda.md#lifecycle-hooks).

## Planned: user code hooks

A future release ([#63](https://github.com/beeblastco/broods/issues/63)) will let you
upload small TypeScript hooks that run **per-invocation in a fresh, egress-less V8
isolate** — around agent run states (compatible with the Vercel AI SDK callbacks) and at
channel/webhook integration points (e.g. update a record when an inbound webhook arrives,
or transform a message before it is sent to a channel). This is **not available yet**;
it is tracked under the V8-isolate core runtime epic
([#85](https://github.com/beeblastco/broods/issues/85)). Until then, use setup commands for
sandbox initialization and [Lifecycle Webhooks](../../webhook.md) for event delivery.
