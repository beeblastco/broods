# Sandbox providers

Every provider runs the same tools, but setup, storage and network support differ. Pick one from the comparison on [Sandboxes](index.md), then configure it here. The `machine` provider has its own page, [Your computer](machine.md).

## `sandbox`

The default provider runs Firecracker VMs on Broods-hosted machines. It supports workspace mounts, persistence with pause and resume, background jobs with logs and stop, the live dashboard terminal, and the Create snapshot action.

```ts
export const box = defineSandbox({
  name: "box",
  provider: "sandbox",
  size: "small",
  network: { mode: "restricted", allowDomains: ["pypi.org"] },
  permissionMode: "edit",
  options: { docker: true },
});
```

- `options.docker: true` enables Docker inside the sandbox. It is accepted only on this provider.
- `options.cpu`, `options.memoryMb` and `options.diskGb` override the size. vCPU is one of 0.5, 1, 2 or 4.
- `options.mountAwsS3Buckets: true` mounts workspace storage even when no workspace sets `storage`.
- `snapshot` names an image to boot.

Self-hosting this provider has guest image requirements, covered in [Sandbox internals](../../internals/sandboxes.md).

## `lambda`

Each session runs in one AWS Lambda MicroVM with real `bash`, `python3`, Node 22, `uv` and `ripgrep`. It supports workspace mounts, persistence through suspend and resume, background jobs and the live terminal.

```ts
export const box = defineSandbox({
  name: "box",
  provider: "lambda",
  network: { mode: "deny-all" },
  permissionMode: "ask",
  envVars: { MY_API_BASE: "https://api.example.com" },
});
```

- MicroVM images come in sizes from 0.5 GB with 0.25 vCPU up to 8 GB with 4 vCPU. The image sets the machine, so `size` only changes what the dashboard shows.
- A MicroVM lives at most 8 hours. A persistent reservation is recreated after that.
- `restricted` behaves like `deny-all`, and `allowDomains` or `allowCidrs` are rejected. Under `deny-all` the managed workspace bucket stays reachable.
- A workspace that brings its own bucket cannot be reached under `deny-all`. Pair it with `allow-all`.
- The workspace mount cannot append or edit in place. `>>` and in-place edits fail. The `write` and `edit` tools rewrite whole files, so tell the agent not to append.
- The image, roles and log group are managed by the platform. `options.functionNames`, `options.executionRoleArn` and `options.logGroup` are rejected.
- Create snapshot is not available. MicroVM images are built ahead of time and selected by `snapshot`.
- `broods logs --sandbox <uuid>` and the Instances Logs tab show what the guest itself writes to stdout and stderr.

The first exec after a resume can take 1 to 10 seconds while the VM restores.

## `daytona`

Runs on a [Daytona](https://daytona.io/docs) sandbox and supports workspace mounts through a `mount-s3` snapshot.

```ts
export const box = defineSandbox({
  name: "daytona",
  provider: "daytona",
  permissionMode: "ask",
  options: {
    snapshot: "fuse-s3",
    target: "default",
    workspaceRoot: "/mnt/workspaces",
    mountAwsS3Buckets: true,
  },
});
```

- Set your Daytona credentials in `options.apiKey`, `organizationId`, `apiUrl` and `target`, with `env("NAME")` for the key. A self-hosted deployment can set fallbacks for every account. See [Self-hosting](../../internals/self-hosting.md).
- Set `options.mountAwsS3Buckets: true` for workspace tools. The snapshot must include `mount-s3`.
- Use `options.snapshot` for Daytona snapshots and `options.image` only to create from a Docker image.
- `network.mode` maps to Daytona's `networkBlockAll`. `restricted` applies the CIDR allowlist only; domain lists are ignored with a warning.
- Idle and lifetime map to Daytona's `autoStopInterval` and `autoDeleteInterval`.
- TypeScript files are not transpiled. Run compiled JavaScript, and call `python3` explicitly.
- `options.s3Endpoint` must be a public `https` URL.

| Symptom                                                 | Fix                                                                                                                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Daytona has no available runner for snapshot '<name>'` | The snapshot is pinned to one runner, or that runner is full. Rebuild it as a general snapshot, drop a `target` that does not match the snapshot's region, or retry |

## `e2b`

Runs on an [E2B](https://e2b.dev/docs) template. Use it for compute without a workspace.

```ts
export const box = defineSandbox({
  name: "e2b",
  provider: "e2b",
  network: { mode: "allow-all" },
  permissionMode: "ask",
  options: { template: "runtime-template" },
});
```

- `network.mode` must be `allow-all`, set explicitly. E2B cannot enforce egress limits, so `deny-all`, the default, and `restricted` are rejected.
- Workspaces are not supported. Attaching one fails.
- `onCreate` and `onResume` are rejected. Put setup in the template.
- Set your E2B key in `options.apiKey`. A self-hosted deployment can set a fallback for every account, see [Self-hosting](../../internals/self-hosting.md). `templateId` is an alias for `template`.
- Persistent mode pauses on idle and keeps files, installs and processes.
- Background jobs run natively, and `async_status` offers `status` only, without `logs` or `stop`.
- The template needs Python for background-job completion callbacks.

## `vercel`

Runs on [Vercel Sandbox](https://vercel.com/docs/sandbox). Use it for compute without a workspace.

```ts
export const box = defineSandbox({
  name: "vercel",
  provider: "vercel",
  persistent: true,
  network: { mode: "restricted", allowDomains: ["api.example.com"] },
  permissionMode: "bypass",
  onCreate: ["npm install"],
  onResume: ["test -d node_modules"],
  options: { image: "vercel/sandbox/universal:latest" },
});
```

- Set your Vercel credentials in `options.token`, `teamId` and `projectId`. A self-hosted deployment can set fallbacks for every account. See [Self-hosting](../../internals/self-hosting.md).
- `options.image` takes a managed image or an OCI image in your project's Vercel Container Registry. `runtime` is deprecated and cannot be combined with `image`.

  | Image                                                        | Contents                                                            |
  | ------------------------------------------------------------ | ------------------------------------------------------------------- |
  | `vercel/sandbox/universal:latest`                            | Node.js 24, Bun, Python 3.14, coding agents, dev tools. The default |
  | `vercel/sandbox/node:22`, `:24`, `:26`                       | Smaller Node.js images                                              |
  | `vercel/sandbox/python:3.14`                                 | Python with pip, venv and uv                                        |
  | `vercel/sandbox/ubuntu:latest`, `vercel/sandbox/arch:latest` | General base images                                                 |

- All three network modes are enforced natively.
- Workspaces are not supported, and `storage.provider: "vercel"` is rejected. A persistent sandbox keeps its own filesystem.
- `onResume` fires only when a stopped sandbox resumes. The idle timeout counts from start, and `maxLifetimeSeconds` is not enforced.

| Symptom                                                | Fix                                                                                                        |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `Vercel Sandbox rejected the request (HTTP 403 / 401)` | The token is invalid, expired, or cannot reach the team and project. Check it at vercel.com/account/tokens |

## Environment variables in every provider

`envVars` is a flat map of strings, read the usual way. Use `$MY_API_BASE` in shell, `process.env.MY_API_BASE` in Node, `os.environ["MY_API_BASE"]` in Python. Each run starts from an empty environment, so only the keys you declare reach it.
