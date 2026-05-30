# Kubernetes

Runs the agent's bash/node/python inside an [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox)
`Sandbox` pod on the Beeblast **k3s cluster** — a VM-like runtime (`bash`, `node`, `python3`, `curl`
on PATH) whose network is inherited from the cluster. The workspace is the same shared S3 bucket the
other providers use, mounted at the `sandbox/` prefix.

Infra side (controller install, runtime image, IAM, cluster identity, debugging, migration) is
documented in the `beeblastco/infra` repo: `docs/agent-sandbox.md`.

## Configuration

```json
{
  "config": {
    "workspace": {
      "storage": { "provider": "s3" },
      "sandbox": {
        "provider": "kubernetes",
        "timeout": 60,
        "options": {
          "namespace": "agent-sandboxes",
          "image": "ghcr.io/beeblastco/agent-sandbox-runtime:latest",
          "serviceAccountName": "agent-sandbox-workspace",
          "imagePullSecrets": ["ghcr-pull-secret"],
          "workspaceRoot": "/mnt/workspaces",
          "mountAwsS3Buckets": true
        }
      }
    }
  }
}
```

Every `options.*` value has an env/default fallback, so a minimal config is just
`{ "provider": "kubernetes" }`:

| Option | Env fallback | Default |
| --- | --- | --- |
| `kubeconfig` (base64) | `KUBERNETES_SANDBOX_KUBECONFIG` (SST secret) | ambient kubeconfig (local only) |
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
3. If `mountAwsS3Buckets` is set, runs `mount-s3 --prefix sandbox/ <bucket> <workspaceRoot>` inside
   the pod (the container runs `privileged` so FUSE works).
4. Execs the command via the kube exec API, **streaming** stdout/stderr.
5. Deletes the `Sandbox` (ephemeral-per-run, like Daytona/E2B).

Cluster auth uses the `agent-sandbox-workspace` ServiceAccount bearer token in the kubeconfig.
The pod's AWS credentials for `mount-s3` come from **IRSA** (no static keys): the SA is annotated
with the cluster's IAM role and the cluster's pod-identity webhook injects a web-identity token.

## Requirements

- Harness deployed with `KUBERNETES_SANDBOX_KUBECONFIG` set (CI: GitHub secret of the same name; see
  the infra doc for how to generate it from the SA token).
- The harness runtime must be able to reach the cluster API (`https://<api>:6443`) and open exec
  websockets. The `HarnessProcessing` Lambda is not VPC-attached, so it has public egress by default.
- For the S3 mount: `mountAwsS3Buckets: true`, the workspace bucket granted to the cluster IAM role
  (infra `workspace_bucket_names`), and the runtime image present in GHCR with a pull secret in the
  namespace. Without the mount, runs still work but files do **not** persist across calls.

## Execution Notes

- It's a real shell: `bash`, `node <file>`, `python3 <file>` all run natively. `python <file>` is
  rewritten to `python3`. Inline execution (`node -e`, `python -c`) is rejected by the bash tool.
- Files persist across calls **only** with the S3 mount enabled (each call gets a fresh pod).

## Local dry-run

Validate the executor against a cluster without a deployed harness:

```bash
KUBECONFIG=/path/to/kubeconfig.yaml \
KUBERNETES_SANDBOX_DEBUG_STREAM=1 \
bun run examples/sandbox-kubernetes-dryrun.ts
```

`KUBERNETES_SANDBOX_DEBUG_STREAM=1` tees the exec stream to your terminal. (Under `bun`, set
`NODE_TLS_REJECT_UNAUTHORIZED=0` if your kubeconfig CA isn't honored — a bun TLS quirk; real Node
Lambda honors it.)

The full agent flow example is `examples/sandbox-kubernetes.ts`.
