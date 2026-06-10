/**
 * Kubernetes-backed workspace sandbox executor.
 *
 * Runs the agent's bash/node/python inside an agent-sandbox `Sandbox`
 * (agents.x-k8s.io/v1alpha1) pod on the Beeblast k3s cluster. Ephemeral by
 * default (create -> wait Ready -> mount-s3 -> exec -> delete); persistent mode
 * reserves one Sandbox per workspace (deterministic name, home PVC, resume by
 * scaling replicas 0->1) and is reclaimed cluster-side by the infra reaper +
 * shutdownTime backstop — see docs/agent-sandbox.md.
 *
 * Cluster connectivity comes from service-managed env/SSM kubeconfig settings,
 * with ambient kubeconfig only for local direct executor tests. S3 credentials
 * inside the pod come from IRSA / pod identity — no harness AWS credentials are
 * injected into the sandbox.
 */

import { Buffer } from "node:buffer";
import { Writable, type Readable } from "node:stream";
import {
  CoreV1Api,
  CustomObjectsApi,
  Exec,
  KubeConfig,
  NetworkingV1Api,
  type V1Pod,
  type V1Status,
} from "@kubernetes/client-node";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { optionalEnv } from "../../_shared/env.ts";
import { logWarn } from "../../_shared/log.ts";
import {
  DEFAULT_PERSISTENT_DISK_GB,
  DEFAULT_PERSISTENT_HOME,
  DEFAULT_RELEASE_GRACE_SECONDS,
  MAX_CONCURRENT_BACKGROUND_JOBS,
  WORKSPACE_MOUNT_PREFIX,
  resolveSandboxLifecycle,
} from "../../_shared/sandbox.ts";
import type {
  SandboxExecutor,
  SandboxExecutorConfig,
  SandboxJobHandle,
  SandboxJobLogs,
  SandboxJobRequest,
  SandboxJobStatus,
  SandboxRunRequest,
  SandboxRunResult,
} from "./types.ts";
import {
  configString,
  isRecordObject,
  persistentSandboxName,
  requiredWorkspacePath,
  sandboxReservationKey,
  shellQuote,
  slugFor,
  truncateText,
} from "./utils.ts";
import {
  generateJobId,
  launchScript,
  lifecycleScript,
  logsScript,
  parseJobStatus,
  statusScript,
  stopScript,
} from "./jobs.ts";

const SANDBOX_GROUP = "agents.x-k8s.io";
const SANDBOX_VERSION = "v1alpha1";
const SANDBOX_PLURAL = "sandboxes";
const CONTAINER_NAME = "main";
const DEFAULT_NAMESPACE = "agent-sandboxes";
const DEFAULT_IMAGE = "ghcr.io/beeblastco/agent-sandbox-runtime:latest";
const DEFAULT_WORKSPACE_SERVICE_ACCOUNT = "agent-sandbox-workspace";
const POD_READY_TIMEOUT_MS = 120_000;
const POD_POLL_INTERVAL_MS = 500;
// Reserved-sandbox home volume + the labels/annotations the infra reaper reads.
const HOME_VOLUME_NAME = "home";
const LAST_ACTIVITY_ANNOTATION = "beeblast.co/last-activity-at";
const IDLE_TIMEOUT_ANNOTATION = "beeblast.co/idle-timeout-seconds";
const MANAGED_LABEL = "beeblast.co/persistent";
const SANDBOX_NAME_LABEL = "beeblast.co/sandbox-name";

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut?: boolean;
}

export class KubernetesSandboxExecutor implements SandboxExecutor {
  readonly #config: SandboxExecutorConfig;
  // Clients are initialized lazily: the kubeconfig may have to be fetched from SSM
  // (it is too large for a Lambda env var), which is async.
  #core!: CoreV1Api;
  #custom!: CustomObjectsApi;
  #networking!: NetworkingV1Api;
  #exec!: Exec;
  #clientsReady?: Promise<void>;

  constructor(config: SandboxExecutorConfig) {
    this.#config = config;
  }

  #ensureClients(): Promise<void> {
    if (!this.#clientsReady) {
      this.#clientsReady = (async () => {
        const kc = await resolveKubeConfig(options(this.#config));
        this.#core = kc.makeApiClient(CoreV1Api);
        this.#custom = kc.makeApiClient(CustomObjectsApi);
        this.#networking = kc.makeApiClient(NetworkingV1Api);
        this.#exec = new Exec(kc);
      })();
    }
    return this.#clientsReady;
  }

  async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    const startedAt = Date.now();
    return this.#withSandbox(request, async (pod) => {
      const result = await this.#execInPod(pod, this.#wrapShell(request, request.code), request.timeoutSeconds);
      const stdout = truncateText(result.stdout, request.outputLimitBytes);
      const stderr = truncateText(result.stderr, request.outputLimitBytes);
      return {
        ok: result.exitCode === 0,
        runtime: request.runtime ?? "bash",
        exitCode: result.exitCode,
        stdout: stdout.value,
        stderr: stderr.value,
        durationMs: Date.now() - startedAt,
        timedOut: result.timedOut === true,
        truncated: stdout.truncated || stderr.truncated,
        provider: "kubernetes",
      };
    });
  }

  async prewarm(request: { namespace?: string; reservationKey?: string }): Promise<void> {
    // Only persistent reservations have a pod to warm; ephemeral runs create
    // their own sandbox per call. Create/resume + wait Ready so the next real
    // call execs into a live pod. touchActivity keeps the reaper off it.
    if (!this.#isPersistent(request)) return;
    await this.#ensureClients();
    const k8sNamespace = kubeNamespace(options(this.#config));
    const name = persistentSandboxName(sandboxReservationKey(request)!);
    await this.#ensurePersistentSandbox(k8sNamespace, name);
    await this.#touchActivity(k8sNamespace, name);
  }

  async execInReservedPod(
    request: { namespace?: string; reservationKey?: string },
    command: string[],
    opts: { stdin?: Readable; timeoutSeconds?: number; outputLimitBytes?: number; onStdout?: (chunk: string) => void } = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut?: boolean }> {
    const pod = await this.#resumeForJob(request);
    const result = await this.#execInPod(pod, command, opts.timeoutSeconds ?? 60, opts.stdin, opts.onStdout);
    const limit = opts.outputLimitBytes;
    return {
      stdout: limit ? truncateText(result.stdout, limit).value : result.stdout,
      stderr: limit ? truncateText(result.stderr, limit).value : result.stderr,
      exitCode: result.exitCode,
      ...(result.timedOut ? { timedOut: true } : {}),
    };
  }

  async runBackground(request: SandboxRunRequest): Promise<SandboxJobHandle> {
    if (!this.#isPersistent(request)) {
      throw new Error("background jobs require a persistent kubernetes sandbox with a workspace");
    }
    const pod = await this.#resumeForJob(request);
    await this.#prepareWorkspace(pod, request);
    await this.#runLifecycle(pod, requiredWorkspacePath(request, "/mnt/workspaces"));
    const jobId = request.jobId ?? generateJobId();
    const workDir = requiredWorkspacePath(request, "/mnt/workspaces");
    // Detached session: the work outlives this exec and survives the request.
    const script = launchScript(this.#jobsDir(), jobId, workDir, request.code, {
      maxConcurrentJobs: MAX_CONCURRENT_BACKGROUND_JOBS,
      ...(request.callback ? { callback: request.callback } : {}),
    });
    await this.#execOrThrow(pod, ["bash", "-lc", script]);
    return { jobId };
  }

  async jobStatus(request: SandboxJobRequest): Promise<SandboxJobStatus> {
    const pod = await this.#resumeForJob(request);
    const result = await this.#execInPod(pod, ["bash", "-lc", statusScript(this.#jobsDir(), request.jobId)], 30);
    return parseJobStatus(request.jobId, result.stdout);
  }

  async jobLogs(request: SandboxJobRequest): Promise<SandboxJobLogs> {
    const pod = await this.#resumeForJob(request);
    const bytes = request.outputLimitBytes ?? 64 * 1024;
    const result = await this.#execInPod(pod, ["bash", "-lc", logsScript(this.#jobsDir(), request.jobId, bytes)], 30);
    const logs = truncateText(result.stdout, bytes);
    return { jobId: request.jobId, logs: logs.value, truncated: logs.truncated };
  }

  async stopJob(request: SandboxJobRequest): Promise<SandboxJobStatus> {
    const pod = await this.#resumeForJob(request);
    await this.#execInPod(pod, ["bash", "-lc", stopScript(this.#jobsDir(), request.jobId)], 30);
    // Report the real terminal state: a job that had already finished keeps its
    // own exit code instead of being recorded as killed.
    const status = await this.#execInPod(pod, ["bash", "-lc", statusScript(this.#jobsDir(), request.jobId)], 30);
    return parseJobStatus(request.jobId, status.stdout);
  }

  #jobsDir(): string {
    return `${persistentHome(options(this.#config))}/.jobs`;
  }

  async #resumeForJob(request: { namespace?: string; reservationKey?: string }): Promise<V1Pod> {
    const key = sandboxReservationKey(request);
    if (!key) {
      throw new Error("job operations require a persistent sandbox reservation key");
    }
    await this.#ensureClients();
    const k8sNamespace = kubeNamespace(options(this.#config));
    const name = persistentSandboxName(key);
    const pod = await this.#ensurePersistentSandbox(k8sNamespace, name);
    // Refresh activity up front so the reaper does not scale this sandbox to 0
    // mid-launch / mid-poll (the launch marker alone races the reaper window).
    await this.#touchActivity(k8sNamespace, name);
    return pod;
  }

  #isPersistent(request: { namespace?: string; reservationKey?: string }): boolean {
    const key = sandboxReservationKey(request);
    return this.#config.persistent === true && typeof key === "string" && key.length > 0;
  }

  async #withSandbox<T>(
    request: { namespace?: string; reservationKey?: string; workspaceRoot?: string },
    run: (pod: V1Pod) => Promise<T>,
  ): Promise<T> {
    await this.#ensureClients();
    const k8sNamespace = kubeNamespace(options(this.#config));

    // Reserved sandbox: reconnect to (or create) the long-lived Sandbox for this
    // reservation key, resuming it if the reaper scaled it to 0. Workspace tools
    // usually use namespace as the key; uploaded custom tools use reservationKey
    // so they do not pretend to have a workspace namespace.
    // Never deleted here — the infra reaper scales it down on idle; release tears
    // it down.
    if (this.#isPersistent(request)) {
      const name = persistentSandboxName(sandboxReservationKey(request)!);
      const pod = await this.#ensurePersistentSandbox(k8sNamespace, name);
      await this.#prepareWorkspace(pod, request);
      await this.#runLifecycle(pod, requiredWorkspacePath(request, "/mnt/workspaces"));
      await this.#touchActivity(k8sNamespace, name);
      return await run(pod);
    }

    // Ephemeral: one Sandbox per call, torn down afterward.
    const name = sandboxName(request.namespace);
    await this.#createSandbox(k8sNamespace, name, false);
    try {
      await this.#ensureNetworkPolicy(k8sNamespace, name);
      const pod = await this.#waitForPodReady(k8sNamespace, name);
      await this.#prepareWorkspace(pod, request);
      return await run(pod);
    } finally {
      await this.#deleteNetworkPolicy(k8sNamespace, name);
      await this.#deleteSandbox(k8sNamespace, name);
    }
  }

  async #ensurePersistentSandbox(k8sNamespace: string, name: string): Promise<V1Pod> {
    const existing = await this.#getSandbox(k8sNamespace, name);
    if (!existing) {
      try {
        await this.#createSandbox(k8sNamespace, name, true);
      } catch (cause) {
        // A concurrent first-touch for the same reservation may have created it
        // first (deterministic name). Treat that as success and wait for its pod.
        if (!isAlreadyExists(cause)) throw cause;
      }
    } else if (sandboxReplicas(existing) === 0) {
      // Resume on demand: the reaper idled this sandbox; scale it back up.
      await this.#scaleSandbox(k8sNamespace, name, 1);
    }
    await this.#ensureNetworkPolicy(k8sNamespace, name);
    return this.#waitForPodReady(k8sNamespace, name);
  }

  async #getSandbox(k8sNamespace: string, name: string): Promise<Record<string, unknown> | undefined> {
    try {
      return (await this.#custom.getNamespacedCustomObject({
        group: SANDBOX_GROUP,
        version: SANDBOX_VERSION,
        namespace: k8sNamespace,
        plural: SANDBOX_PLURAL,
        name,
      })) as Record<string, unknown>;
    } catch (cause) {
      if (isNotFound(cause)) return undefined;
      throw cause;
    }
  }

  async #scaleSandbox(k8sNamespace: string, name: string, replicas: number): Promise<void> {
    // JSON Patch (RFC 6902) — matches the client's default json-patch+json type.
    await this.#custom.patchNamespacedCustomObject({
      group: SANDBOX_GROUP,
      version: SANDBOX_VERSION,
      namespace: k8sNamespace,
      plural: SANDBOX_PLURAL,
      name,
      body: [{ op: "replace", path: "/spec/replicas", value: replicas }],
    });
  }

  async #touchActivity(k8sNamespace: string, name: string): Promise<void> {
    // Best-effort: the reaper tolerates a stale/missing annotation, and a missing
    // patch RBAC grant must not fail the user's command. Refresh both the
    // last-activity annotation (idle reaper) and the hard-expiry shutdownTime
    // (leak backstop) so an actively-used sandbox never self-deletes.
    try {
      await this.#custom.patchNamespacedCustomObject({
        group: SANDBOX_GROUP,
        version: SANDBOX_VERSION,
        namespace: k8sNamespace,
        plural: SANDBOX_PLURAL,
        name,
        body: [
          {
            op: "add",
            path: `/metadata/annotations/${escapeJsonPointer(LAST_ACTIVITY_ANNOTATION)}`,
            value: isoSeconds(),
          },
          { op: "add", path: "/spec/shutdownTime", value: this.#shutdownTimeFromNow() },
        ],
      });
    } catch (err) {
      // Best-effort, but log it: a persistent patch failure (missing RBAC) means
      // shutdownTime never refreshes, so an in-use sandbox could self-delete.
      logWarn("kubernetes sandbox activity refresh failed", {
        name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  #shutdownTimeFromNow(): string {
    const lifecycle = resolveSandboxLifecycle(this.#config.lifecycle);
    const graceSeconds = lifecycle.maxLifetimeSeconds ?? DEFAULT_RELEASE_GRACE_SECONDS;
    return new Date(Date.now() + graceSeconds * 1000).toISOString();
  }

  async #createSandbox(
    k8sNamespace: string,
    name: string,
    persistent: boolean,
  ): Promise<void> {
    const opts = options(this.#config);
    const mounting = opts.mountAwsS3Buckets === true;
    const home = persistent ? persistentHome(opts) : undefined;
    // A durable home means a cloud-volume PVC (slow to create+attach). When
    // ephemeralHome is set we still point HOME at the same path, but it resolves
    // to the image's own node-owned home — no PVC, near-instant cold-start.
    const durableHome = home !== undefined && this.#config.ephemeralHome !== true;
    const container: Record<string, unknown> = {
      name: CONTAINER_NAME,
      image: configString(opts.image) ?? optionalEnv("KUBERNETES_SANDBOX_IMAGE") ?? DEFAULT_IMAGE,
      command: ["sleep", "infinity"],
      env: envList({
        ...(this.#config.envVars ?? {}),
        ...sandboxRegionEnv(opts),
        // Point HOME + package-manager caches at the persistent home PVC so
        // pip/npm/uv state survives a scale-to-0.
        ...(home ? persistentHomeEnv(home) : {}),
      }),
    };
    if (mounting) {
      // mount-s3 needs FUSE + root: privileged grants the FUSE device, runAsUser 0 lets
      // mount-s3 perform the mount (the image otherwise runs as uid 1000).
      container.securityContext = { privileged: true, runAsUser: 0 };
    }
    if (durableHome) {
      container.volumeMounts = [{ name: HOME_VOLUME_NAME, mountPath: home }];
    }

    const podSpec: Record<string, unknown> = { containers: [container] };
    if (durableHome && !mounting) {
      // The home PVC mounts root-owned, but a non-S3 sandbox runs as the image
      // user (uid 1000). Without fsGroup the user cannot write ${HOME}, so e.g.
      // background-job tracking under ${HOME}/.jobs fails and detached jobs never
      // start. fsGroup makes the volume group-writable for that user.
      podSpec.securityContext = { fsGroup: 1000, fsGroupChangePolicy: "OnRootMismatch" };
    }
    const sa = configString(opts.serviceAccountName) ?? optionalEnv("KUBERNETES_SANDBOX_SERVICE_ACCOUNT") ??
      (mounting ? DEFAULT_WORKSPACE_SERVICE_ACCOUNT : undefined);
    if (sa) podSpec.serviceAccountName = sa;
    const pullSecrets = stringList(opts.imagePullSecrets) ?? stringList(optionalEnv("KUBERNETES_SANDBOX_IMAGE_PULL_SECRETS"));
    if (pullSecrets?.length) podSpec.imagePullSecrets = pullSecrets.map((n) => ({ name: n }));

    const metadata: Record<string, unknown> = { name };
    const spec: Record<string, unknown> = {
      podTemplate: {
        metadata: { labels: { [SANDBOX_NAME_LABEL]: name } },
        spec: podSpec,
      },
    };
    if (persistent) {
      const lifecycle = resolveSandboxLifecycle(this.#config.lifecycle);
      metadata.labels = { [MANAGED_LABEL]: "true" };
      // Seed the annotations map so later single-key JSON Patch `add` ops work,
      // and publish the reaper's idle budget alongside last-activity.
      metadata.annotations = {
        [LAST_ACTIVITY_ANNOTATION]: isoSeconds(),
        [IDLE_TIMEOUT_ANNOTATION]: String(lifecycle.idleTimeoutSeconds),
      };
      spec.replicas = 1;
      // Hard-expiry backstop (refreshed on every use): an abandoned sandbox
      // self-deletes, so reserved sandboxes never leak.
      spec.shutdownPolicy = "Delete";
      spec.shutdownTime = this.#shutdownTimeFromNow();
      if (durableHome) spec.volumeClaimTemplates = [homePvcTemplate(opts)];
    }

    await this.#custom.createNamespacedCustomObject({
      group: SANDBOX_GROUP,
      version: SANDBOX_VERSION,
      namespace: k8sNamespace,
      plural: SANDBOX_PLURAL,
      body: {
        apiVersion: `${SANDBOX_GROUP}/${SANDBOX_VERSION}`,
        kind: "Sandbox",
        metadata,
        spec,
      },
    });
  }

  async #ensureNetworkPolicy(k8sNamespace: string, name: string): Promise<void> {
    const network = this.#config.network ?? { mode: "deny-all" as const };
    if (network.mode === "allow-all") {
      await this.#deleteNetworkPolicy(k8sNamespace, name);
      return;
    }
    if (network.mode === "restricted" && (network.allowDomains?.length ?? 0) > 0) {
      logWarn("kubernetes sandbox ignores restricted network domain allowlist; only CIDRs are enforced", {
        allowDomains: network.allowDomains?.length ?? 0,
      });
    }
    const cidrs = network.mode === "restricted" ? (network.allowCidrs ?? []) : [];
    const except = network.mode === "restricted" ? (network.denyCidrs ?? []) : [];
    // restricted keeps DNS reachable (port 53 to any resolver) — without it the
    // CIDR allowlist is unusable by hostname. deny-all stays fully closed.
    const egress = network.mode === "restricted"
      ? [
          { ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }] },
          ...(cidrs.length > 0
            ? [{ to: cidrs.map((cidr) => ({ ipBlock: { cidr, ...(except.length > 0 ? { except } : {}) } })) }]
            : []),
        ]
      : [];
    const body = {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name, namespace: k8sNamespace },
      spec: {
        podSelector: { matchLabels: { [SANDBOX_NAME_LABEL]: name } },
        policyTypes: ["Egress"],
        egress,
      },
    };
    try {
      await this.#networking.createNamespacedNetworkPolicy({ namespace: k8sNamespace, body });
    } catch (cause) {
      if (!isAlreadyExists(cause)) throw cause;
      await this.#networking.replaceNamespacedNetworkPolicy({ namespace: k8sNamespace, name, body });
    }
  }

  async #deleteNetworkPolicy(k8sNamespace: string, name: string): Promise<void> {
    try {
      await this.#networking.deleteNamespacedNetworkPolicy({ namespace: k8sNamespace, name });
    } catch (cause) {
      if (!isNotFound(cause)) {
        logWarn("kubernetes sandbox network policy cleanup failed", {
          name,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
  }

  async #deleteSandbox(k8sNamespace: string, name: string): Promise<void> {
    try {
      await this.#custom.deleteNamespacedCustomObject({
        group: SANDBOX_GROUP,
        version: SANDBOX_VERSION,
        namespace: k8sNamespace,
        plural: SANDBOX_PLURAL,
        name,
      });
    } catch {
      // best-effort teardown; the controller GCs orphaned pods with the Sandbox
    }
  }

  async #waitForPodReady(k8sNamespace: string, name: string): Promise<V1Pod> {
    const deadline = Date.now() + POD_READY_TIMEOUT_MS;
    let last: V1Pod | undefined;
    while (Date.now() < deadline) {
      try {
        const pod = await this.#core.readNamespacedPod({ name, namespace: k8sNamespace });
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
    request: { namespace?: string; workspaceRoot?: string },
  ): Promise<void> {
    const opts = options(this.#config);
    const dir = requiredWorkspacePath(request, "/mnt/workspaces");
    const workspaceRoot = (request.workspaceRoot ?? "/mnt/workspaces").replace(/\/+$/, "");
    await this.#execOrThrow(pod, ["bash", "-lc", `mkdir -p ${shellQuote(workspaceRoot)}`]);
    await this.#execOrThrow(pod, ["bash", "-lc", `mkdir -p ${shellQuote(dir)}`]);
    if (opts.mountAwsS3Buckets === true) {
      if (!request.namespace) {
        throw new Error("kubernetes S3 workspace mount requires a workspace namespace.");
      }
      const bucket = configString(opts.workspaceBucketName) ?? optionalEnv("FILESYSTEM_BUCKET_NAME");
      if (!bucket) {
        throw new Error(
          "kubernetes S3 workspace mount requires sandbox options.workspaceBucketName or FILESYSTEM_BUCKET_NAME.",
        );
      }
      const region = configString(opts.awsRegion) ?? optionalEnv("AWS_REGION") ?? optionalEnv("AWS_DEFAULT_REGION");
      const mountArgs = [
        "--allow-delete",
        "--allow-overwrite",
        "--allow-other",
        "--prefix",
        `${WORKSPACE_MOUNT_PREFIX}/${request.namespace}/`,
        ...(region ? ["--region", region] : []),
        bucket,
        dir,
      ].map(shellQuote).join(" ");
      // Present mounted files as uid/gid 1000 (the workspace access point's owner),
      // not the mounting process's uid: the pod runs as root for FUSE, and mount-s3
      // rejects --uid 0. Root still reads/writes the files (and --allow-other covers
      // any non-root access). Idempotent: a reused persistent pod may already have
      // the mount, so skip when the directory is already a mountpoint.
      await this.#execOrThrow(pod, [
        "bash",
        "-lc",
        `mountpoint -q ${shellQuote(dir)} || mount-s3 --uid 1000 --gid 1000 ${mountArgs}`,
      ]);
    }
  }

  #wrapShell(request: { workspaceRoot?: string; namespace?: string }, shell: string): string[] {
    return ["bash", "-lc", `cd ${shellQuote(requiredWorkspacePath(request, "/mnt/workspaces"))}; ${shell}`];
  }

  async #execOrThrow(pod: V1Pod, command: string[]): Promise<void> {
    const result = await this.#execInPod(pod, command, 60);
    if ((result.exitCode ?? 0) !== 0) {
      throw new Error(`sandbox setup command failed (${result.exitCode}): ${command.join(" ")}\n${result.stderr || result.stdout}`);
    }
  }

  async #runLifecycle(pod: V1Pod, workDir: string): Promise<void> {
    const script = lifecycleScript(workDir, this.#config.onCreate, this.#config.onResume);
    if (!script) return;
    await this.#execOrThrow(pod, ["bash", "-lc", script]);
  }

  async #execInPod(pod: V1Pod, command: string[], timeoutSeconds: number, stdin?: Readable, onStdout?: (chunk: string) => void): Promise<ExecResult> {
    const k8sNamespace = pod.metadata?.namespace ?? kubeNamespace(options(this.#config));
    const podName = pod.metadata?.name ?? "";
    const debugStream = optionalEnv("KUBERNETES_SANDBOX_DEBUG_STREAM") === "1";

    let stdout = "";
    let stderr = "";
    const stdoutStream = new Writable({
      write(chunk, _enc, cb) {
        const text = chunk.toString();
        stdout += text;
        onStdout?.(text);
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
        resolve({
          stdout,
          stderr: `${stderr}\n[sandbox exec timed out after ${timeoutSeconds}s]`,
          exitCode: null,
          timedOut: true,
        });
      }, timeoutSeconds * 1000);

      this.#exec
        .exec(
          k8sNamespace,
          podName,
          CONTAINER_NAME,
          command,
          stdoutStream,
          stderrStream,
          stdin ?? null,
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

function options(config: SandboxExecutorConfig): Record<string, unknown> {
  return isRecordObject(config.options) ? config.options : {};
}

async function resolveKubeConfig(opts: Record<string, unknown>): Promise<KubeConfig> {
  const kc = new KubeConfig();
  // 1) inline base64 (config option or small deployments) 2) SSM parameter (the
  // kubeconfig is too big for a Lambda env var, so prod passes its SSM name)
  // 3) ambient kubeconfig (local direct executor tests).
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

function sandboxName(namespace: string | undefined): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `fp-${slugFor(namespace, "ws")}-${suffix}`;
}

function persistentHome(opts: Record<string, unknown>): string {
  return (configString(opts.persistentHome) ?? DEFAULT_PERSISTENT_HOME).replace(/\/+$/, "") || DEFAULT_PERSISTENT_HOME;
}

function persistentHomeEnv(home: string): Record<string, string> {
  return {
    HOME: home,
    XDG_CACHE_HOME: `${home}/.cache`,
    XDG_DATA_HOME: `${home}/.local/share`,
    XDG_CONFIG_HOME: `${home}/.config`,
    NPM_CONFIG_CACHE: `${home}/.npm`,
    PIP_CACHE_DIR: `${home}/.cache/pip`,
    UV_CACHE_DIR: `${home}/.cache/uv`,
    UV_PYTHON_INSTALL_DIR: `${home}/.local/uv/python`,
  };
}

function homePvcTemplate(opts: Record<string, unknown>): Record<string, unknown> {
  const diskGb = positiveInteger(opts.persistentDiskGb) ?? DEFAULT_PERSISTENT_DISK_GB;
  const storageClass = configString(opts.storageClass);
  return {
    // Labeled so the reaper can sweep this PVC if its Sandbox is later deleted.
    metadata: { name: HOME_VOLUME_NAME, labels: { [MANAGED_LABEL]: "true" } },
    spec: {
      accessModes: ["ReadWriteOnce"],
      resources: { requests: { storage: `${diskGb}Gi` } },
      ...(storageClass ? { storageClassName: storageClass } : {}),
    },
  };
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function sandboxReplicas(sandbox: Record<string, unknown>): number {
  const spec = isRecordObject(sandbox.spec) ? sandbox.spec : {};
  return typeof spec.replicas === "number" ? spec.replicas : 1;
}

// JSON Pointer (RFC 6901) escaping for annotation keys that contain `/`.
function escapeJsonPointer(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

// ISO-8601 without milliseconds — the reaper parses this with jq fromdateiso8601,
// which rejects fractional seconds.
function isoSeconds(date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function isNotFound(cause: unknown): boolean {
  if (!isRecordObject(cause)) return false;
  if (cause.code === 404 || cause.statusCode === 404) return true;
  return isRecordObject(cause.body) && cause.body.reason === "NotFound";
}

function isAlreadyExists(cause: unknown): boolean {
  if (!isRecordObject(cause)) return false;
  if (cause.code === 409 || cause.statusCode === 409) return true;
  return isRecordObject(cause.body) && cause.body.reason === "AlreadyExists";
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
