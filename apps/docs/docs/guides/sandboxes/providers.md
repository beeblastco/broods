# Sandbox providers

Every provider runs the same tools, but setup, storage and network support differ. Pick one from the comparison on [Sandboxes](index.md), then configure it here.

| Provider                   | Runs on                      | Section                                                   |
| -------------------------- | ---------------------------- | --------------------------------------------------------- |
| `sandbox`                  | Broods-hosted Firecracker VM | [`sandbox`](#sandbox)                                     |
| `lambda`                   | AWS Lambda MicroVM           | [`lambda`](#lambda)                                       |
| `daytona`, `e2b`, `vercel` | A vendor account you bring   | [`daytona`](#daytona), [`e2b`](#e2b), [`vercel`](#vercel) |
| `cloudflare`               | Cloudflare Container         | [`cloudflare`](#cloudflare)                               |
| `worker`                   | Fast Cloudflare V8 Worker    | [`worker`](#worker)                                       |
| `machine`                  | Your own computer            | [Your computer](machine.md)                               |
| `custom`                   | Your server over HTTP        | [Your own server](custom.md)                              |

## `sandbox`

Runs Firecracker VMs on a workdir node. The hosted service does not offer it yet, so use `lambda` there; a self-hosted deployment points it at its own node. It supports workspace mounts, persistence with pause and resume, background jobs with logs and stop, the live dashboard terminal, and the Create snapshot action.

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

- Every MicroVM is the same machine: a 2 GB baseline that bursts to 4 vCPU and 8 GB, on an 8 GB disk. `size` and resource options do not change it, and the dashboard shows that machine.
- A MicroVM lives at most 8 hours. A persistent reservation is recreated after that.
- `restricted` behaves like `deny-all`, and `allowDomains` or `allowCidrs` are rejected. Under `deny-all` the managed workspace bucket stays reachable.
- A workspace that brings its own bucket cannot be reached under `deny-all`, so the run is refused. Pair it with `allow-all`.
- The workspace mount cannot append or edit in place. `>>` and in-place edits fail. The `write` and `edit` tools rewrite whole files, so tell the agent not to append.
- The image, roles and log group are managed by the platform. `options` accepts only `workspaceRoot` and `reservationKey`.
- The Snapshot action builds a new image from the files a running machine changed, see [Images](index.md#images). `image: "obscura"` or `image: "browser"` boots a platform image with a headless browser. `snapshot` pins an image by ARN, in the same AWS account and region as the default. Any other ARN, a snapshot another account built, or one taken on another stage, fails the run.
- `broods logs --sandbox <uuid>` and the Instances Logs tab show what the guest itself writes to stdout and stderr.

The first exec after a resume can take 1 to 10 seconds while the VM restores.

## `daytona`

Runs on a [Daytona](https://daytona.io/docs) sandbox and supports workspace mounts through a `mount-s3` snapshot.

```ts
export const box = defineSandbox({
  name: "daytona",
  provider: "daytona",
  permissionMode: "ask",
  snapshot: "fuse-s3",
  options: {
    target: "default",
    workspaceRoot: "/mnt/workspaces",
    mountAwsS3Buckets: true,
  },
});
```

- Set your Daytona credentials in `options.apiKey`, `organizationId`, `apiUrl` and `target`, with `env("NAME")` for the key. A self-hosted deployment can set fallbacks for every account. See [Self-hosting](../../internals/self-hosting.md).
- Set `options.mountAwsS3Buckets: true` for workspace tools. The snapshot must include `mount-s3`.
- `snapshot` names the Daytona snapshot to boot. `options.image` instead builds the sandbox from a Docker image when it is created. Set one or the other.
- The Snapshot action captures a reserved sandbox's filesystem as a new Daytona snapshot, see [Images](index.md#images).
- `network.mode` maps to Daytona's `networkBlockAll`. `restricted` applies the CIDR allowlist only; domain lists are ignored with a warning.
- Idle and lifetime map to Daytona's `autoStopInterval` and `autoDeleteInterval`.
- `size` does nothing here. The dashboard shows the vCPU, memory and disk Daytona reports for the sandbox.
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
  snapshot: "runtime-template",
});
```

- `network.mode` must be `allow-all`, set explicitly. E2B cannot enforce egress limits, so `deny-all`, the default, and `restricted` are rejected.
- Workspaces are not supported. Attaching one fails.
- `onCreate` and `onResume` are rejected. Put setup in the template.
- The template sets the machine size, and `size` does nothing. The dashboard shows the vCPU and memory E2B reports, and `?` for disk, which E2B does not report.
- Set your E2B key in `options.apiKey`. A self-hosted deployment can set a fallback for every account, see [Self-hosting](../../internals/self-hosting.md).
- `snapshot` names the E2B template or snapshot to boot. The Snapshot action captures a reserved sandbox as an E2B snapshot, pausing it while it captures.
- Persistent mode pauses on idle and keeps files, installs and processes.
- Background jobs run natively, and `async_status` offers `status` only, without `logs` or `stop`.
- The template needs Python for background-job completion callbacks.

## `vercel`

Runs on [Vercel Sandbox](https://vercel.com/docs/sandbox) and mounts any workspace attached to it.

```ts
export const box = defineSandbox({
  name: "vercel",
  provider: "vercel",
  persistent: true,
  network: { mode: "restricted", allowDomains: ["api.example.com"] },
  permissionMode: "bypass",
  onCreate: ["npm install"],
  onResume: ["test -d node_modules"],
  // A snapshot with mount-s3 already installed, so a restricted network can
  // mount a workspace. See the install note below.
  snapshot: "snap_with_mount_s3",
});
```

- Set your Vercel credentials in `options.token`, `teamId` and `projectId`. A self-hosted deployment can set fallbacks for every account. See [Self-hosting](../../internals/self-hosting.md).
- `snapshot` takes a managed image, an OCI image in your project's Vercel Container Registry, or a Vercel snapshot id, which starts with `snap_`.

  | Image                                                        | Contents                                                            |
  | ------------------------------------------------------------ | ------------------------------------------------------------------- |
  | `vercel/sandbox/universal:latest`                            | Node.js 24, Bun, Python 3.14, coding agents, dev tools. The default |
  | `vercel/sandbox/node:22`, `:24`, `:26`                       | Smaller Node.js images                                              |
  | `vercel/sandbox/python:3.14`                                 | Python with pip, venv and uv                                        |
  | `vercel/sandbox/ubuntu:latest`, `vercel/sandbox/arch:latest` | General base images                                                 |

- The Snapshot action captures a reserved sandbox as a Vercel snapshot that does not expire. Vercel stops the sandbox to capture it, and its next call resumes it.
- All three network modes are enforced natively.
- `options.networkId` attaches the sandbox to a [Secure Compute](https://vercel.com/docs/sandbox/concepts/secure-compute) network, so its public traffic leaves from the network's static IPs and it reaches your AWS VPC over peering. Secure Compute needs a Vercel Enterprise team; the ID is under Settings, Networking. `network.mode` still applies, so a `restricted` sandbox lists the private hosts it calls. A reserved sandbox moves to a changed network once its current session ends.
- `size` does nothing here. The dashboard shows the vCPU and memory once Vercel reports them, and `?` for disk, which Vercel does not report.
- A workspace attached to the sandbox is mounted, with no option to set. Each call mounts the workspace's S3 prefix at `/mnt/workspaces/<namespace>` with Mountpoint for S3, on hour-long credentials scoped to that prefix. They stay out of the sandbox env and the agent's commands, but code with `sudo` can read them from the mount process, as on Daytona. The mount is replaced after 45 minutes or when a resumed session lost it. The harness needs `SANDBOX_MOUNT_ROLE_ARN`, or the workspace names its own bucket with `assumeRole` or R2 auth.
- The images ship without `mount-s3`, so the first mount installs it, which takes about 10 seconds and needs egress to `s3.amazonaws.com` and the Ubuntu mirrors. Under `restricted` or `deny-all`, or to skip the install, install it once in a reserved sandbox, capture it with the Snapshot action, and boot that `snap_` id. The workspace bucket's S3 hosts are always allowed, as on `lambda`.
- `storage.provider: "vercel"` (Vercel Drives) is rejected.
- `lifecycle.idleTimeoutSeconds` is at most 24 hours. Vercel holds one session to 24 hours on Pro and Enterprise and to 45 minutes on Hobby, so a longer idle window is refused. Each call extends the session to one idle window past its own end. A session that reaches the plan cap stops, and the next call resumes it.
- `maxLifetimeSeconds` is checked when a call takes the sandbox. The call that trips it boots a fresh one.

| Symptom                                                | Fix                                                                                                        |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `Vercel Sandbox rejected the request (HTTP 403 / 401)` | The token is invalid, expired, or cannot reach the team and project. Check it at vercel.com/account/tokens |

## `cloudflare`

Runs `bash` in a [Cloudflare Container](https://developers.cloudflare.com/sandbox/) with `bash`, `python3`, Node 24, `git` and `ripgrep`. Use it for compute without a workspace.

```ts
export const box = defineSandbox({
  name: "cloudflare",
  provider: "cloudflare",
  persistent: true,
  size: "small",
  network: { mode: "allow-all" },
  permissionMode: "ask",
  lifecycle: { idleTimeoutSeconds: 600 },
});
```

| Field                          | Behavior                                                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `persistent`                   | `true` keeps one Container per agent while it is warm. `false` uses a new one per call                     |
| `lifecycle.idleTimeoutSeconds` | How long a warm Container waits for the next command before it sleeps. Default 15 minutes, at most 6 hours |
| `network.mode`                 | `allow-all` turns internet on, `deny-all` turns it off, `restricted` is rejected                           |
| `size`                         | The nearest Cloudflare instance type, from `standard-1` for `tiny` to `standard-4` for `large`             |
| `options`                      | Only `workspaceRoot` and `reservationKey`                                                                  |

- A Container that sleeps loses its files. Persistence keeps installs and files only while it stays warm, so keep setup in a step the agent can rerun.
- Changing `network.mode` or `size` replaces a warm Container.
- Workspaces are not supported. Attaching one fails.
- `onCreate`, `onResume`, `snapshot` and `lifecycle.maxLifetimeSeconds` are rejected. Background jobs, suspend, resume and the Snapshot action are not available.
- `config.harness` agents cannot run here. Use `sandbox` or `lambda`.
- A `persistent` sandbox gets the live dashboard terminal, a login shell in `/workspace`. It opens only on a running Container, so run a command first to wake one that slept.
- The provider needs the deployment's Cloudflare bridge. Without it every run fails with an error saying the bridge is not configured. A self-hosted deployment deploys its own, see [Sandbox internals](../../internals/sandboxes.md#cloudflare).

## `worker`

Runs `bash` in a V8 isolate on Cloudflare Workers: no container, no machine, nothing running between commands. The shell is [just-bash](https://github.com/vercel-labs/just-bash), a bash written in TypeScript with its own in-memory disk and 81 built-in commands: `cat`, `grep`, `sed`, `awk`, `jq`, `find`, `sort`, `cut`, `gzip`, `base64`, `sha256sum`, `date` and the rest of the text toolbox, plus `curl` once internet is on. Use it for the cheapest compute an agent can get: a command starts in well under a second and costs only the milliseconds it ran.

```ts
export const box = defineSandbox({
  name: "worker",
  provider: "worker",
  persistent: true,
  network: { mode: "allow-all" },
  permissionMode: "bypass",
  timeout: 30,
});
```

| Field          | Behavior                                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------------- |
| `persistent`   | `true` keeps the sandbox's files between calls, in storage. `false` runs every call on an empty disk           |
| `network.mode` | `allow-all` registers `curl` and turns internet on, `deny-all` has no network at all, `restricted` is rejected |
| `timeout`      | Seconds per call, at most 60: the isolate's CPU limit is the call's timeout                                    |
| `options`      | Only `workspaceRoot` and `reservationKey`                                                                      |

- Only built-ins run. There is no `python`, `node`, `git`, `npm` or any binary, no process and no port; a command outside the 81 answers `command not found`. Use `sandbox` or `lambda` for a real machine.
- Files are the sandbox's whole state. A persistent sandbox restores them into a fresh shell on every call and stores what changed, up to 24 MiB on disk and 16 MiB compressed; an ephemeral one keeps nothing. The shell's own layout (`/bin`, `/dev`, `/proc`) is rebuilt every time and never stored.
- Each call runs in 128 MB of memory, and a command that never yields is stopped at the timeout by the isolate's CPU limit.
- The shell itself stops a script at 100,000 commands, 100,000 loop iterations or 100 nested function calls, with an error naming the limit. A job that big belongs on `sandbox` or `lambda`.
- `size` does nothing, like on `lambda`: every command gets the same 128 MB. `snapshot`, `lifecycle`, `onCreate`, `onResume` and workspaces are rejected. Background jobs, suspend, resume, the Snapshot action and the live terminal are not available.
- `config.harness` agents cannot run here. Use `sandbox` or `lambda`.
- Billing counts only the milliseconds each command took, waits included, plus one request each, inside Sandbox time; nothing idles. A `sleep` costs the same as a busy command, a fraction of a VM's idle time.
- The provider needs the deployment's V8 Worker. Without it every run fails with an error saying the Worker is not configured. A self-hosted deployment deploys its own, see [Sandbox internals](../../internals/sandboxes.md#worker).

## Environment variables in every provider

`envVars` is a flat map of strings, read the usual way. Use `$MY_API_BASE` in shell, `process.env.MY_API_BASE` in Node, `os.environ["MY_API_BASE"]` in Python. Each run starts from an empty environment, so only the keys you declare reach it.
