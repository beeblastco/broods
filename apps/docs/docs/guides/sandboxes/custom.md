# Your own server as a sandbox

The `custom` provider runs the agent's `bash` tool on a server you operate. Broods POSTs each command to your endpoint and reads the result back. Anything that can answer one JSON request can be a sandbox: a container fleet, a bare-metal box, an existing job runner. The compute is yours, so nothing is metered or held to a plan budget.

A `custom` sandbox is stateless. Every call is one request, so there is no persistence, no background job, no workspace mount and no dashboard terminal. Pair it with a `machine` or a managed provider when the agent needs files that survive between calls.

## Configure

```ts title="broods/index.ts"
import { defineAgent, defineSandbox, env } from "broods";

export const fleet = defineSandbox({
  name: "fleet",
  provider: "custom",
  network: { mode: "allow-all" },
  permissionMode: "ask",
  timeout: 60,
  options: {
    endpoint: "https://sandbox.example.com",
    token: env("SANDBOX_TOKEN"),
    headers: { "x-team": "ops" },
  },
});

export const helper = defineAgent({
  name: "helper",
  sandboxes: [fleet],
});
```

| Option     | Required | Description                                                                                     |
| ---------- | -------- | ----------------------------------------------------------------------------------------------- |
| `endpoint` | yes      | Public `https` URL of your server, no query or fragment. Broods POSTs to `<endpoint>/exec`      |
| `token`    | no       | Sent as `Authorization: Bearer <token>`. Use `env("NAME")` to keep it out of code               |
| `headers`  | no       | Extra static headers on every request. A credential header's value must be an `env("NAME")` ref |

`env("NAME")` resolves when `broods dev` or `broods deploy` syncs the project. A sandbox created through the REST API keeps `${NAME}` as written and its runs fail on it, so pass the credential as `token` there.

`network.mode` must be `allow-all`, set explicitly: Broods cannot enforce egress on a server it does not run. `persistent`, `size` and `snapshot` are rejected, a workspace cannot be attached, and `custom` cannot be a `fallbackProvider`. `envVars` and `timeout` apply as on every provider.

Broods resolves the endpoint's name, refuses any private, loopback or metadata address, pins the connection to the address it validated and follows no redirects. A tunnel or a reverse proxy with a public name is fine; a private IP is not.

## The contract

One route, `POST <endpoint>/exec`, JSON in and JSON out. The types are exported from the SDK as `SandboxExecRequest` and `SandboxExecResponse`.

Request:

| Field                         | Type                     | Description                                                                                                                                    |
| ----------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime`                     | `bash`, `python`, `node` | Which interpreter runs `code`. Broods sends `bash`                                                                                             |
| `code`                        | string                   | The script                                                                                                                                     |
| `timeout_ms`                  | number                   | Kill the process and answer `timed_out: true` once this passes                                                                                 |
| `env`                         | object                   | The process environment. Start from empty, add at most the defaults a process needs to start (`HOME`, `TMPDIR`, `PATH`), then set these on top |
| `args`                        | string[]                 | Positional arguments, when present                                                                                                             |
| `namespace`, `workspace_root` | string                   | Working-directory hints. Never sent by `custom`; a server may ignore them                                                                      |

Response, always HTTP 200 once the request was understood:

| Field              | Type           | Description                                                         |
| ------------------ | -------------- | ------------------------------------------------------------------- |
| `ok`               | boolean        | False when the process failed, timed out or the request was invalid |
| `exit_code`        | number or null | Null when the timeout killed the process                            |
| `timed_out`        | boolean        |                                                                     |
| `duration_ms`      | number         | Wall-clock time of the run                                          |
| `stdout`, `stderr` | string         | Captured output. Cut them to a sane size and set `truncated`        |
| `truncated`        | boolean        | True when you cut the output                                        |
| `cpu_usec`         | number         | CPU time in microseconds, shown in usage. Optional                  |

Answer a bad token with 401 and a malformed body with 400. Broods surfaces any non-2xx status with its body as the tool error. On the client side Broods waits `timeout_ms` plus fifteen seconds, then gives up on the call, and cuts `stdout`, `stderr` and an error body to the sandbox's `outputLimitBytes`. A response body over 5 MB fails the call instead, so truncate on the server.

## A server in Bun

A minimal starting point: enough to run the contract on one box. Run it behind TLS with a public name and put the URL in `options.endpoint`.

```ts title="sandbox-server.ts"
import type { SandboxExecRequest, SandboxExecResponse } from "broods";

const TOKEN = process.env.SANDBOX_TOKEN;

Bun.serve({
  port: 8080,
  async fetch(request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/exec") {
      return new Response("not found", { status: 404 });
    }
    if (TOKEN && request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
      return new Response("bad token", { status: 401 });
    }
    const exec = (await request
      .json()
      .catch((): null => null)) as SandboxExecRequest | null;
    if (typeof exec?.code !== "string" || typeof exec.timeout_ms !== "number") {
      return new Response("bad request", { status: 400 });
    }
    const startedAt = Date.now();
    const proc = Bun.spawn(
      ["bash", "-c", exec.code, "bash", ...(exec.args ?? [])],
      {
        env: exec.env,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const killer = setTimeout(() => proc.kill(), exec.timeout_ms);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(killer);
    const timedOut = proc.signalCode !== null;
    const body: SandboxExecResponse = {
      ok: !timedOut && exitCode === 0,
      runtime: "bash",
      exit_code: timedOut ? null : exitCode,
      timed_out: timedOut,
      duration_ms: Date.now() - startedAt,
      stdout: stdout,
      stderr: stderr,
    };

    return Response.json(body);
  },
});
```

This runs commands as the server's own user with no isolation. It is a starting point for a server that already isolates work, not something to expose to an agent on its own. Before real use, also:

- Kill the command's whole process group on timeout. `proc.kill()` stops only the shell, and a child that keeps a pipe open holds the request until it exits.
- Cap `stdout` and `stderr` while reading them and set `truncated`, instead of buffering everything a command prints.

## A production server

The same contract is what the `lambda` provider speaks to its MicroVM image. That server, [lambda-sanbdox](https://github.com/beeblastco/lambda-sanbdox), is written in Rust and adds what a shared box needs: a fresh working directory per request, a process environment cleared down to `HOME`, `TMPDIR` and `PATH`, output capture with truncation, a timeout that kills the whole process group, exact CPU accounting and the `python` and `node` runtimes.

Its `/exec` does not check the bearer token: on a MicroVM the platform's proxy authenticates the caller before the request reaches it. Never publish the container's port directly. Run it on a private network behind an HTTPS gateway that checks `Authorization` against your token and forwards only `POST /exec`, then point `options.endpoint` at the gateway.

To add a provider to Broods itself rather than run one over HTTP, see [Sandbox internals](../../internals/sandboxes.md#contribute-a-provider).
