/**
 * Kubernetes-backed workspace sandbox executor.
 *
 * Runs the agent's bash/node/python inside an agent-sandbox `Sandbox`
 * (agents.x-k8s.io/v1alpha1) pod on the Beeblast k3s cluster — a "VM-like"
 * environment with node, python, bash, curl on PATH. Mirrors the Daytona
 * executor's ephemeral lifecycle: create Sandbox -> wait Ready -> (optionally
 * mount the workspace S3 bucket with mount-s3 at the `sandbox/` prefix) ->
 * exec -> delete.
 *
 * Cluster connectivity comes from a kubeconfig (config.options.kubeconfig or
 * KUBERNETES_SANDBOX_KUBECONFIG, both base64; falls back to the ambient
 * kubeconfig for local/dry-run). S3 credentials inside the pod come from IRSA
 * (the pod's ServiceAccount annotated with the beeblast_k3s_role ARN + the
 * cluster's aws-pod-identity-webhook) — no static keys. See
 * infra: kubernetes/agent-sandbox/runtime/README.md.
 */

import { Buffer } from "node:buffer";
import { Writable } from "node:stream";
import {
  CoreV1Api,
  CustomObjectsApi,
  Exec,
  KubeConfig,
  type V1Pod,
  type V1Status,
} from "@kubernetes/client-node";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { optionalEnv } from "../../_shared/env.ts";
import { WORKSPACE_MOUNT_PREFIX } from "../../_shared/sandbox.ts";
import type {
  WorkspaceSandboxConfig,
  WorkspaceSandboxExecutor,
  WorkspaceSandboxReadDirRequest,
  WorkspaceSandboxReadDirResult,
  WorkspaceSandboxRunRequest,
  WorkspaceSandboxRunResult,
  WorkspaceSandboxShellRequest,
  WorkspaceSandboxShellResult,
} from "./types.ts";

const SANDBOX_GROUP = "agents.x-k8s.io";
const SANDBOX_VERSION = "v1alpha1";
const SANDBOX_PLURAL = "sandboxes";
const CONTAINER_NAME = "main";
const DEFAULT_NAMESPACE = "agent-sandboxes";
const DEFAULT_IMAGE = "ghcr.io/beeblastco/agent-sandbox-runtime:latest";
const POD_READY_TIMEOUT_MS = 120_000;
const POD_POLL_INTERVAL_MS = 1_500;

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export class KubernetesWorkspaceSandboxExecutor implements WorkspaceSandboxExecutor {
  readonly #config: WorkspaceSandboxConfig;
  // Clients are initialized lazily: the kubeconfig may have to be fetched from SSM
  // (it is too large for a Lambda env var), which is async.
  #core!: CoreV1Api;
  #custom!: CustomObjectsApi;
  #exec!: Exec;
  #clientsReady?: Promise<void>;

  constructor(config: WorkspaceSandboxConfig) {
    this.#config = config;
  }

  #ensureClients(): Promise<void> {
    if (!this.#clientsReady) {
      this.#clientsReady = (async () => {
        const kc = await resolveKubeConfig(options(this.#config));
        this.#core = kc.makeApiClient(CoreV1Api);
        this.#custom = kc.makeApiClient(CustomObjectsApi);
        this.#exec = new Exec(kc);
      })();
    }
    return this.#clientsReady;
  }

  async runShell(request: WorkspaceSandboxShellRequest): Promise<WorkspaceSandboxShellResult> {
    const startedAt = Date.now();
    return this.#withSandbox(request, async (pod) => {
      const result = await this.#execInPod(pod, this.#wrapShell(request, request.shell), request.timeoutSeconds);
      const stdout = truncateText(result.stdout, request.outputLimitBytes);
      const stderr = truncateText(result.stderr, request.outputLimitBytes);
      return {
        ok: (result.exitCode ?? 0) === 0,
        exitCode: result.exitCode,
        stdout: stdout.value,
        stderr: stderr.value,
        durationMs: Date.now() - startedAt,
        truncated: stdout.truncated || stderr.truncated,
        provider: "kubernetes",
      };
    });
  }

  async runFile(request: WorkspaceSandboxRunRequest): Promise<WorkspaceSandboxRunResult> {
    const startedAt = Date.now();
    return this.#withSandbox(request, async (pod) => {
      const result = await this.#execInPod(pod, this.#wrapShell(request, commandForFile(request)), request.timeoutSeconds);
      const stdout = truncateText(result.stdout, request.outputLimitBytes);
      const stderr = truncateText(result.stderr, request.outputLimitBytes);
      return {
        ok: (result.exitCode ?? 0) === 0,
        runtime: request.runtime,
        exitCode: result.exitCode,
        stdout: stdout.value,
        stderr: stderr.value,
        artifacts: [],
        durationMs: Date.now() - startedAt,
        truncated: stdout.truncated || stderr.truncated,
        provider: "kubernetes",
      };
    });
  }

  async readDirectory(request: WorkspaceSandboxReadDirRequest): Promise<WorkspaceSandboxReadDirResult> {
    const dir = `${workspacePath(request)}/${request.path.replace(/^\/+/, "")}`.replace(/\/+$/, "");
    // Emit each file as a "<relpath>\t<base64>" line so the client can split it back
    // apart. find + base64 keeps it to a single exec round-trip.
    const script =
      `cd ${shellQuote(dir)} 2>/dev/null || exit 0; ` +
      `find . -type f -printf '%P\\n' | while IFS= read -r f; do ` +
      `printf '%s\\t' "$f"; base64 -w0 "$f"; printf '\\n'; done`;
    try {
      return await this.#withSandbox(request, async (pod) => {
        const result = await this.#execInPod(pod, ["bash", "-lc", script], 60);
        const maxBytes = request.maxBytes ?? Number.POSITIVE_INFINITY;
        const files: WorkspaceSandboxReadDirResult["files"] = [];
        let total = 0;
        let truncated = false;
        for (const line of result.stdout.split("\n")) {
          if (!line) continue;
          const tab = line.indexOf("\t");
          if (tab < 0) continue;
          const path = line.slice(0, tab);
          const base64 = line.slice(tab + 1);
          total += base64.length;
          if (total > maxBytes) { truncated = true; break; }
          files.push({ path, base64 });
        }
        return { ok: true, files, truncated, provider: "kubernetes" as const };
      });
    } catch (cause) {
      return {
        ok: false,
        files: [],
        error: cause instanceof Error ? cause.message : String(cause),
        provider: "kubernetes",
      };
    }
  }

  // --- internals -----------------------------------------------------------

  async #withSandbox<T>(
    request: { namespace: string; workspaceRoot: string },
    run: (pod: V1Pod) => Promise<T>,
  ): Promise<T> {
    await this.#ensureClients();
    const opts = options(this.#config);
    const namespace = kubeNamespace(opts);
    const name = sandboxName(request.namespace);
    await this.#createSandbox(namespace, name, request);
    try {
      const pod = await this.#waitForPodReady(namespace, name);
      await this.#prepareWorkspace(pod, request);
      return await run(pod);
    } finally {
      await this.#deleteSandbox(namespace, name);
    }
  }

  async #createSandbox(
    namespace: string,
    name: string,
    request: { namespace: string; workspaceRoot: string },
  ): Promise<void> {
    const opts = options(this.#config);
    const mounting = opts.mountAwsS3Buckets === true;
    const container: Record<string, unknown> = {
      name: CONTAINER_NAME,
      image: configString(opts.image) ?? optionalEnv("KUBERNETES_SANDBOX_IMAGE") ?? DEFAULT_IMAGE,
      command: ["sleep", "infinity"],
      env: envList({ ...(this.#config.envVars ?? {}), ...sandboxRegionEnv(opts) }),
    };
    if (mounting) {
      // mount-s3 needs FUSE; the simplest reliable grant on k3s is a privileged container.
      container.securityContext = { privileged: true };
    }

    const podSpec: Record<string, unknown> = { containers: [container] };
    const sa = configString(opts.serviceAccountName) ?? optionalEnv("KUBERNETES_SANDBOX_SERVICE_ACCOUNT");
    if (sa) podSpec.serviceAccountName = sa;
    const pullSecrets = stringList(opts.imagePullSecrets) ?? stringList(optionalEnv("KUBERNETES_SANDBOX_IMAGE_PULL_SECRETS"));
    if (pullSecrets?.length) podSpec.imagePullSecrets = pullSecrets.map((n) => ({ name: n }));

    await this.#custom.createNamespacedCustomObject({
      group: SANDBOX_GROUP,
      version: SANDBOX_VERSION,
      namespace,
      plural: SANDBOX_PLURAL,
      body: {
        apiVersion: `${SANDBOX_GROUP}/${SANDBOX_VERSION}`,
        kind: "Sandbox",
        metadata: { name },
        spec: { podTemplate: { spec: podSpec } },
      },
    });
  }

  async #deleteSandbox(namespace: string, name: string): Promise<void> {
    try {
      await this.#custom.deleteNamespacedCustomObject({
        group: SANDBOX_GROUP,
        version: SANDBOX_VERSION,
        namespace,
        plural: SANDBOX_PLURAL,
        name,
      });
    } catch {
      // best-effort teardown; the controller GCs orphaned pods with the Sandbox
    }
  }

  async #waitForPodReady(namespace: string, name: string): Promise<V1Pod> {
    const deadline = Date.now() + POD_READY_TIMEOUT_MS;
    let last: V1Pod | undefined;
    while (Date.now() < deadline) {
      try {
        const pod = await this.#core.readNamespacedPod({ name, namespace });
        last = pod;
        const ready = (pod.status?.conditions ?? []).some((c) => c.type === "Ready" && c.status === "True");
        if (ready) return pod;
        const phase = pod.status?.phase;
        if (phase === "Failed" || phase === "Succeeded") {
          throw new Error(`sandbox pod ${name} entered terminal phase ${phase}`);
        }
      } catch (cause) {
        // pod may not exist yet right after Sandbox creation; keep polling
        if (Date.now() >= deadline) throw cause;
      }
      await sleep(POD_POLL_INTERVAL_MS);
    }
    const reason = last?.status?.containerStatuses?.[0]?.state?.waiting?.reason;
    throw new Error(`sandbox pod ${name} not ready within ${POD_READY_TIMEOUT_MS}ms${reason ? ` (${reason})` : ""}`);
  }

  async #prepareWorkspace(
    pod: V1Pod,
    request: { namespace: string; workspaceRoot: string },
  ): Promise<void> {
    const opts = options(this.#config);
    const dir = workspacePath(request);
    await this.#execOrThrow(pod, ["bash", "-lc", `mkdir -p ${shellQuote(request.workspaceRoot)}`]);
    if (opts.mountAwsS3Buckets === true) {
      const bucket = configString(opts.workspaceBucketName) ?? optionalEnv("FILESYSTEM_BUCKET_NAME");
      if (!bucket) {
        throw new Error(
          "kubernetes S3 workspace mount requires config.workspace.sandbox.options.workspaceBucketName or FILESYSTEM_BUCKET_NAME.",
        );
      }
      const region = configString(opts.awsRegion) ?? optionalEnv("AWS_REGION") ?? optionalEnv("AWS_DEFAULT_REGION");
      const mountArgs = [
        "--allow-delete",
        "--allow-overwrite",
        "--allow-other",
        "--prefix",
        `${WORKSPACE_MOUNT_PREFIX}/`,
        ...(region ? ["--region", region] : []),
        bucket,
        request.workspaceRoot,
      ].map(shellQuote).join(" ");
      await this.#execOrThrow(pod, [
        "bash",
        "-lc",
        `mount-s3 --uid "$(id -u)" --gid "$(id -g)" ${mountArgs}`,
      ]);
    }
    await this.#execOrThrow(pod, ["bash", "-lc", `mkdir -p ${shellQuote(dir)}`]);
  }

  #wrapShell(request: { workspaceRoot: string; namespace: string }, shell: string): string[] {
    return ["bash", "-lc", `cd ${shellQuote(workspacePath(request))}; ${shell}`];
  }

  async #execOrThrow(pod: V1Pod, command: string[]): Promise<void> {
    const result = await this.#execInPod(pod, command, 60);
    if ((result.exitCode ?? 0) !== 0) {
      throw new Error(`sandbox setup command failed (${result.exitCode}): ${command.join(" ")}\n${result.stderr || result.stdout}`);
    }
  }

  async #execInPod(pod: V1Pod, command: string[], timeoutSeconds: number): Promise<ExecResult> {
    const namespace = pod.metadata?.namespace ?? kubeNamespace(options(this.#config));
    const podName = pod.metadata?.name ?? "";
    const debugStream = optionalEnv("KUBERNETES_SANDBOX_DEBUG_STREAM") === "1";

    let stdout = "";
    let stderr = "";
    const stdoutStream = new Writable({
      write(chunk, _enc, cb) {
        stdout += chunk.toString();
        if (debugStream) process.stdout.write(chunk);
        cb();
      },
    });
    const stderrStream = new Writable({
      write(chunk, _enc, cb) {
        stderr += chunk.toString();
        if (debugStream) process.stderr.write(chunk);
        cb();
      },
    });

    return await new Promise<ExecResult>((resolve, reject) => {
      let settled = false;
      let exitCode: number | null = 0;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode });
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ stdout, stderr: `${stderr}\n[sandbox exec timed out after ${timeoutSeconds}s]`, exitCode: null });
      }, timeoutSeconds * 1000);

      this.#exec
        .exec(
          namespace,
          podName,
          CONTAINER_NAME,
          command,
          stdoutStream,
          stderrStream,
          null,
          false,
          (status: V1Status) => {
            exitCode = exitCodeFromStatus(status);
          },
        )
        .then((ws) => {
          ws.on("close", () => finish());
          ws.on("error", (err: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(err);
          });
        })
        .catch((err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        });
    });
  }
}

// --- helpers ---------------------------------------------------------------

function options(config: WorkspaceSandboxConfig): Record<string, unknown> {
  return isRecordObject(config.options) ? config.options : {};
}

async function resolveKubeConfig(opts: Record<string, unknown>): Promise<KubeConfig> {
  const kc = new KubeConfig();
  // 1) inline base64 (config option or small deployments) 2) SSM parameter (the
  // kubeconfig is too big for a Lambda env var, so prod passes its SSM name)
  // 3) ambient kubeconfig (local dev / dry-run).
  let raw = configString(opts.kubeconfig) ?? optionalEnv("KUBERNETES_SANDBOX_KUBECONFIG");
  if (!raw) {
    const param = configString(opts.kubeconfigSsmParam) ?? optionalEnv("KUBERNETES_SANDBOX_KUBECONFIG_SSM");
    if (param) {
      raw = await fetchSsmParameter(param);
    }
  }
  if (raw) {
    kc.loadFromString(Buffer.from(raw, "base64").toString("utf8"));
    return kc;
  }
  if (optionalEnv("AWS_LAMBDA_FUNCTION_NAME")) {
    throw new Error(
      "kubernetes sandbox: no kubeconfig available. Set KUBERNETES_SANDBOX_KUBECONFIG (base64) or KUBERNETES_SANDBOX_KUBECONFIG_SSM (SSM parameter name).",
    );
  }
  kc.loadFromDefault();
  return kc;
}

async function fetchSsmParameter(name: string): Promise<string> {
  const client = new SSMClient({});
  const res = await client.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  const value = res.Parameter?.Value?.trim();
  if (!value) {
    throw new Error(`kubernetes sandbox: SSM parameter ${name} is empty or missing.`);
  }
  return value;
}

function kubeNamespace(opts: Record<string, unknown>): string {
  return configString(opts.namespace) ?? optionalEnv("KUBERNETES_SANDBOX_NAMESPACE") ?? DEFAULT_NAMESPACE;
}

function sandboxRegionEnv(opts: Record<string, unknown>): Record<string, string> {
  const region = configString(opts.awsRegion) ?? optionalEnv("AWS_REGION") ?? optionalEnv("AWS_DEFAULT_REGION");
  return region ? { AWS_REGION: region, AWS_DEFAULT_REGION: region } : {};
}

function envList(vars: Record<string, string>): Array<{ name: string; value: string }> {
  return Object.entries(vars).map(([name, value]) => ({ name, value }));
}

function commandForFile(request: WorkspaceSandboxRunRequest): string {
  const executable = request.runtime === "node" ? "node" : "python3";
  return [executable, request.entryPath.replace(/^\/+/, ""), ...request.args].map(shellQuote).join(" ");
}

function sandboxName(namespace: string): string {
  const slug = namespace.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "ws";
  const suffix = Math.random().toString(36).slice(2, 8);
  return `fp-${slug}-${suffix}`;
}

function workspacePath(request: { workspaceRoot: string; namespace: string }): string {
  return `${request.workspaceRoot.replace(/\/+$/, "")}/${request.namespace}`;
}

function exitCodeFromStatus(status: V1Status): number | null {
  if (status?.status === "Success") return 0;
  const causes = status?.details?.causes ?? [];
  for (const cause of causes) {
    if (cause.reason === "ExitCode" && cause.message != null) {
      const code = Number(cause.message);
      return Number.isFinite(code) ? code : null;
    }
  }
  return status?.status === "Failure" ? 1 : null;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function configString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const list = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
    return list.length ? list : undefined;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value.split(",").map((v) => v.trim()).filter(Boolean);
  }
  return undefined;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function truncateText(value: string, limit: number): { value: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= limit) {
    return { value, truncated: false };
  }
  return {
    value: `${new TextDecoder().decode(bytes.slice(0, limit))}\n[output truncated]`,
    truncated: true,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
