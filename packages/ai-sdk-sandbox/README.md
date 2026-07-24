# `@broods/ai-sdk-sandbox`

This package adapts an injected Broods sandbox driver to the experimental
`HarnessV1SandboxProvider` contract in `@ai-sdk/harness@1.0.14`. It is a phase-1
boundary package: the bounded Workdir driver in
`apps/core/src/harness/sandbox/workdir-harness-driver.ts` now imports it, but the
Broods core run loop still does not.

## Boundary

The package owns Harness-facing translation for commands, file streams, network
sessions, restricted session views, and lifecycle calls. It does not import core
runtime internals, select a real sandbox provider, access credentials, or manage
Broods persistence. The core-owned Workdir integration implements the small
`BroodsSandboxDriver` port inside `apps/core` by adapting
`createSandboxExecutor()` and reusing the runtime's existing reservation,
persistence, and cleanup paths. It must not add another provider registry or
session-persistence layer:

```ts
import {
  createBroodsSandbox,
  type BroodsSandboxDriver,
} from "@broods/ai-sdk-sandbox";

const driver: BroodsSandboxDriver =
  createCoreHarnessDriver(/* runtime context */);
const sandbox = createBroodsSandbox({ driver });

// A later runtime phase can pass `sandbox` to HarnessAgent settings.
```

The driver creates or resumes a `BroodsSandboxDriverSession`. A create result
also reports `isFirstCreate`, which the driver sets at most once per stable
identity so Harness bootstrap is not repeated after restoration. The session
provides binary file I/O, foreground and background commands, optional network
policy/port mutation, port URL resolution, and resource cleanup. Provider-specific
errors pass through unchanged so the future integration remains responsible for
classification and retry policy. If creation rejects before returning a session
handle, the driver cleans up any partially allocated resource.

File writes intentionally collect the full input stream into a `Uint8Array`
because that is the current driver contract. Large artifact writes therefore use
memory proportional to the file size; supporting bounded-memory writes will
require a future streaming driver contract rather than a change to this adapter
alone.

## Ownership and lifecycle

- `createSession` returns an adapter-owned session. `stop` and `destroy` are
  idempotent at the adapter boundary and invoke each driver operation at most once.
- Driver `destroy`, when present, must work for either a running or an already
  stopped resource. Without it, the adapter falls back to `stop`.
- Harness `onFirstCreate` receives a restricted view with command and file access,
  but no lifecycle or network controls.
- If `onFirstCreate` fails, the adapter destroys (or stops) the fresh resource and
  rethrows the setup failure. If cleanup also fails, both errors are retained in an
  `AggregateError`.
- `resumeSession` is exposed only when the driver implements durable resume.
- `setNetworkPolicy` and `setPorts` remain absent when the driver cannot enforce
  them. `getPortUrl` reports a Harness capability error when port exposure is not
  supported.

This package deliberately does not define queueing, steering, cancellation,
streaming, WebSocket control, or the live agent run loop. Those remain runtime
integration concerns for later phases. The Workdir driver is likewise not wired
into `HarnessAgent`; that live selection remains blocked on the queue/steer
contract tracked in #71.
