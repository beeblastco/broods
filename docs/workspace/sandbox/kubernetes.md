# Kubernetes

Runs the agent's bash/node/python inside an [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox)
`Sandbox` pod on the Beeblast **k3s cluster** — a VM-like runtime (`bash`, `node`, `python3`, `curl`
on PATH) whose network is inherited from the cluster. The workspace is the same shared S3 bucket the
other providers use, mounted at the selected `sandbox/<namespace>/` prefix for each run.

Infra side (controller install, runtime image, IAM, cluster identity, debugging, migration) is
documented in the `beeblastco/infra` repo: `docs/agent-sandbox.md`.

## Configuration

```json
{
  "name": "kubernetes",
  "config": {
    "provider": "kubernetes",
    "permissionMode": "ask",
    "timeout": 60,
    "options": {
      "workspaceRoot": "/mnt/workspaces",
      "mountAwsS3Buckets": true
    }
  }
}
```

Reference the resulting `sandboxId` from `config.sandbox` or `config.workspaces[].sandbox`.
Cluster-control settings are service-managed and cannot be set in account sandbox config.
They come from deployment env/defaults:

| Option | Env fallback | Default |
| --- | --- | --- |
| kubeconfig | `KUBERNETES_SANDBOX_KUBECONFIG`, then `KUBERNETES_SANDBOX_KUBECONFIG_SSM` (SSM param name) | ambient kubeconfig (local only) |
| `namespace` | `KUBERNETES_SANDBOX_NAMESPACE` | `agent-sandboxes` |
| `image` | `KUBERNETES_SANDBOX_IMAGE` | `ghcr.io/beeblastco/agent-sandbox-runtime:latest` |
| `serviceAccountName` | `KUBERNETES_SANDBOX_SERVICE_ACCOUNT` | pod default SA |
| `imagePullSecrets` | `KUBERNETES_SANDBOX_IMAGE_PULL_SECRETS` (comma-sep) | none |
| `workspaceBucketName` | `FILESYSTEM_BUCKET_NAME` | — |
| `awsRegion` | `AWS_REGION` / `AWS_DEFAULT_REGION` | — |

`sandbox.envVars` passes extra environment variables into the pod (honored by all providers).

## How it works

Per bash/file run the executor (`functions/harness-processing/sandbox/kubernetes-executor.ts`):

1. Creates a `Sandbox` (`agents.x-k8s.io/v1alpha1`) named `fp-<namespace>-<rand>` in the namespace,
   with the runtime image (`command: sleep infinity`).
2. Waits for the pod to be `Ready`.
3. If `mountAwsS3Buckets` is set, runs
   `mount-s3 --prefix sandbox/<namespace>/ <bucket> <workspaceRoot>/<namespace>` inside
   the pod (the container runs `privileged` so FUSE works).
4. Execs the command via the kube exec API, **streaming** stdout/stderr.
5. Deletes the `Sandbox` (ephemeral-per-run, like Daytona/E2B).

> The kubeconfig (CA + token) is ~2.7 KB — over Lambda's 4 KB env-var limit. So `sst.config.ts`
> stores it in an SSM SecureString parameter (`/filthy-panty/<stage>/kubernetes-sandbox-kubeconfig`,
> value from the `KubernetesSandboxKubeconfig` secret) and passes only the parameter **name** as
> `KUBERNETES_SANDBOX_KUBECONFIG_SSM`; the executor fetches + caches it at runtime. Set the GitHub
> secret `KUBERNETES_SANDBOX_KUBECONFIG` (base64 kubeconfig) and deploy — no env-size juggling.

Cluster auth uses the service-managed kubeconfig. For `mount-s3`, the pod must get S3
permissions from its Kubernetes service account / cluster identity; the harness no longer
passes AWS credentials into the pod. The pod runs privileged + `runAsUser: 0` (FUSE needs
the device + root) and mounts with `--uid 1000 --gid 1000`.

> **Mountpoint-for-S3 has no append/in-place edit** (`>>` or editing a file in place fails) — only
> whole-file create/overwrite. The agent should rewrite files, not append. (Same as Daytona's mount.)

## Requirements

- Harness deployed with `KUBERNETES_SANDBOX_KUBECONFIG` set (CI: GitHub secret of the same name; see
  the infra doc for how to generate it from the SA token).
- The harness runtime must be able to reach the cluster API (`https://<api>:6443`) and open exec
  websockets. The `HarnessProcessing` Lambda is not VPC-attached, so it has public egress by default.
- For the S3 mount: `mountAwsS3Buckets: true`; the sandbox pod service account must have
  S3 RW on the workspace bucket, and the runtime image must be in GHCR with a pull secret
  in the namespace. Without the mount, stateless runs still work but workspace-backed tools
  fail fast because files would not persist across calls.
- **TLS on the deployed harness.** The harness Lambda is a bun-compiled binary whose `fetch` ignores
  the kubeconfig CA / `insecure-skip-tls-verify`, and k3s serves a self-signed cert. So `sst.config.ts`
  sets `NODE_TLS_REJECT_UNAUTHORIZED=0` on the harness for **non-production** stages only; production
  keeps full verification and needs a trusted API cert before using this provider. See the infra
  `docs/agent-sandbox.md`.

## Execution Notes

- It's a real shell: `bash`, `node <file>`, `python3 <file>` all run natively. `python <file>` is
  rewritten to `python3`.
- Files persist across calls **only** with the S3 mount enabled (each call gets a fresh pod).

## Direct executor test

Validate the executor against a cluster without a deployed harness:

```bash
KUBECONFIG=/path/to/kubeconfig.yaml \
KUBERNETES_SANDBOX_DEBUG_STREAM=1 \
bun run examples/sandbox-kubernetes-direct.ts
```

`KUBERNETES_SANDBOX_DEBUG_STREAM=1` tees the exec stream to your terminal. (Under `bun`, set
`NODE_TLS_REJECT_UNAUTHORIZED=0` if your kubeconfig CA isn't honored — a bun TLS quirk; real Node
Lambda honors it.)

The full agent flow example is `examples/sandbox-workspace-kubernetes.ts`.
