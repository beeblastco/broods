/**
 * Standalone direct executor smoke test for the kubernetes sandbox provider.
 *
 * Drives KubernetesSandboxExecutor directly against a cluster using the
 * ambient kubeconfig ($KUBECONFIG / ~/.kube/config) — no deployed harness needed.
 * Proves Sandbox create -> pod Ready -> exec -> streaming stdout -> delete.
 *
 * Env knobs:
 *   KUBERNETES_SANDBOX_NAMESPACE   (default agent-sandboxes)
 *   KUBERNETES_SANDBOX_IMAGE       (default ghcr.io/beeblastco/agent-sandbox-runtime:latest)
 *   KUBERNETES_SANDBOX_IMAGE_PULL_SECRETS  (default ghcr-pull-secret)
 */

import { KubernetesSandboxExecutor } from "../functions/harness-processing/sandbox/kubernetes-executor.ts";
import type { SandboxExecutorConfig } from "../functions/harness-processing/sandbox/types.ts";

const namespace = "direct-" + Date.now().toString(36);
const workspaceRoot = "/mnt/workspaces";

const config: SandboxExecutorConfig = {
  provider: "kubernetes",
  timeout: 90,
  outputLimitBytes: 65536,
  envVars: { SANDBOX_SMOKE_VAR: "sandbox-env-ok" },
  options: {
    namespace: process.env.KUBERNETES_SANDBOX_NAMESPACE ?? "agent-sandboxes",
    imagePullSecrets: process.env.KUBERNETES_SANDBOX_IMAGE_PULL_SECRETS ?? "ghcr-pull-secret",
    workspaceRoot,
    // mountAwsS3Buckets intentionally off for this direct executor test (no S3/IRSA dependency).
  },
};

const executor = new KubernetesSandboxExecutor(config);

function banner(title: string): void {
  console.log(`\n=== ${title} ===`);
}

try {
  banner("run: env + write/run python + node + outbound curl");
  const code = [
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

  const shellResult = await executor.run({
    code,
    namespace,
    workspaceRoot,
    timeoutSeconds: 90,
    outputLimitBytes: 65536,
  });
  console.log("\n--- run result ---");
  console.log(JSON.stringify({ ...shellResult, stdout: shellResult.stdout, stderr: shellResult.stderr }, null, 2));

  // Each run provisions a FRESH ephemeral Sandbox (create -> exec -> delete), so a file
  // written above does NOT survive into a separate run without the S3 workspace mount
  // (mountAwsS3Buckets), which is off in this direct executor test. To exercise run-by-path
  // self-contained, write the file and run it by path within a single run.
  banner("run-by-path: self-contained write + run-by-path in one Sandbox");
  const runFileResult = await executor.run({
    code: [
      "cat > prog.js <<'JS'",
      'console.log("runFile path ok", process.argv[1])',
      "JS",
      "node prog.js",
    ].join("\n"),
    namespace,
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
  console.log(`\n=== DIRECT TEST ${ok ? "PASSED ✅" : "completed (review output ⚠️)"} ===`);
  process.exit(ok ? 0 : 1);
} catch (cause) {
  console.error("\n=== DIRECT TEST FAILED ❌ ===");
  console.error(cause instanceof Error ? cause.stack ?? cause.message : String(cause));
  process.exit(1);
}
