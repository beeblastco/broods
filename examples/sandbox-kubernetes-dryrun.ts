/**
 * Standalone dry-run for the kubernetes workspace sandbox executor.
 *
 * Drives KubernetesWorkspaceSandboxExecutor directly against a cluster using the
 * ambient kubeconfig ($KUBECONFIG / ~/.kube/config) — no deployed harness needed.
 * Proves Sandbox create -> pod Ready -> exec -> streaming stdout -> delete.
 *
 * Prereqs (run once against the target cluster):
 *   kubectl create namespace agent-sandboxes
 *   kubectl -n beeblast get secret ghcr-pull-secret -o yaml \
 *     | sed 's/namespace: beeblast/namespace: agent-sandboxes/' \
 *     | kubectl -n agent-sandboxes apply -f -
 *
 * Run:
 *   KUBECONFIG=/path/to/beeblast-prod_kubeconfig.yaml \
 *   KUBERNETES_SANDBOX_DEBUG_STREAM=1 \
 *   bun run examples/sandbox-kubernetes-dryrun.ts
 *
 * Env knobs:
 *   KUBERNETES_SANDBOX_NAMESPACE   (default agent-sandboxes)
 *   KUBERNETES_SANDBOX_IMAGE       (default ghcr.io/beeblastco/agent-sandbox-runtime:latest)
 *   KUBERNETES_SANDBOX_IMAGE_PULL_SECRETS  (default ghcr-pull-secret)
 */

import { KubernetesWorkspaceSandboxExecutor } from "../functions/harness-processing/sandbox/kubernetes-executor.ts";
import type { WorkspaceSandboxConfig } from "../functions/harness-processing/sandbox/types.ts";

const namespace = "dryrun-" + Date.now().toString(36);
const workspaceRoot = "/mnt/workspaces";

const config: WorkspaceSandboxConfig = {
  provider: "kubernetes",
  timeout: 90,
  outputLimitBytes: 65536,
  envVars: { SANDBOX_SMOKE_VAR: "sandbox-env-ok" },
  options: {
    namespace: process.env.KUBERNETES_SANDBOX_NAMESPACE ?? "agent-sandboxes",
    imagePullSecrets: process.env.KUBERNETES_SANDBOX_IMAGE_PULL_SECRETS ?? "ghcr-pull-secret",
    workspaceRoot,
    // mountAwsS3Buckets intentionally off for the dry-run (no S3/IRSA dependency).
  },
};

const executor = new KubernetesWorkspaceSandboxExecutor(config);

function banner(title: string): void {
  console.log(`\n=== ${title} ===`);
}

try {
  banner("runShell: env + write/run python + node + outbound curl");
  const shell = [
    'echo "shell:$SANDBOX_SMOKE_VAR"',
    "cat > main.py <<'PY'",
    "import sys",
    'print("python ok", sys.version.split()[0])',
    "PY",
    "python3 main.py",
    "cat > main.js <<'JS'",
    'console.log("node ok", process.version)',
    "JS",
    "node main.js",
    "echo -n 'http_status='; curl -s -o /dev/null -w '%{http_code}' https://example.com || echo 'curl-failed'",
    "echo",
  ].join("\n");

  const shellResult = await executor.runShell!({
    namespace,
    shell,
    workspaceRoot,
    timeoutSeconds: 90,
    outputLimitBytes: 65536,
  });
  console.log("\n--- runShell result ---");
  console.log(JSON.stringify({ ...shellResult, stdout: shellResult.stdout, stderr: shellResult.stderr }, null, 2));

  // NOTE on runFile: each call provisions a FRESH ephemeral Sandbox (create -> exec
  // -> delete), so a file written in the runShell above does NOT survive into a
  // separate runFile call without the S3 workspace mount (mountAwsS3Buckets), which is
  // off in this dry-run. To exercise runFile self-contained, write the file and run it
  // by path within the same Sandbox via a single runShell that ends in `node <file>`.
  banner("runFile semantics: self-contained write + run-by-path in one Sandbox");
  const runFileResult = await executor.runShell!({
    namespace,
    shell: [
      "cat > prog.js <<'JS'",
      'console.log("runFile path ok", process.argv[1])',
      "JS",
      "node prog.js",
    ].join("\n"),
    workspaceRoot,
    timeoutSeconds: 60,
    outputLimitBytes: 65536,
  });
  console.log("\n--- run-by-path result ---");
  console.log(JSON.stringify(runFileResult, null, 2));

  const ok = shellResult.ok && shellResult.stdout.includes("sandbox-env-ok") &&
    shellResult.stdout.includes("python ok") && shellResult.stdout.includes("node ok") &&
    shellResult.stdout.includes("http_status=200") &&
    runFileResult.ok && runFileResult.stdout.includes("runFile path ok");
  console.log(`\n=== DRY-RUN ${ok ? "PASSED ✅" : "completed (review output ⚠️)"} ===`);
  process.exit(ok ? 0 : 1);
} catch (cause) {
  console.error("\n=== DRY-RUN FAILED ❌ ===");
  console.error(cause instanceof Error ? cause.stack ?? cause.message : String(cause));
  process.exit(1);
}
