/**
 * Account management HTTP API.
 * Keep account orchestration here and shared records/persistence at their boundaries.
 */

import {
  roleDenial,
  rolePrincipal,
} from "@broods/convex/model/apiAuthorization";
import { createSandboxExecutor } from "../harness/sandbox/index.ts";
import type { SandboxExecutor } from "../harness/sandbox/types.ts";
import { getSandboxExternalId } from "../harness/sandbox/instance-store.ts";
import {
  MICROVM_SHELL_AUTH_HEADER,
  microvmShellConnection,
} from "../harness/sandbox/microvm-executor.ts";
import {
  workdirConnection,
  workdirPtyUrl,
} from "../harness/sandbox/workdir-executor.ts";
import { resolveBearerAuth, type AuthContext } from "../shared/auth.ts";
import {
  recordSandboxAuditEvent,
  type SandboxAuditActor,
} from "../shared/convex/sandbox-audit-events.ts";
import {
  removeSandboxInstance,
  sandboxInstanceIsControllable,
  setSandboxInstanceStatus,
  type SandboxInstanceStatus,
} from "../shared/convex/sandbox-instances.ts";
import { upsertSandboxSnapshot } from "../shared/convex/sandbox-snapshots.ts";
import {
  normalizeCreateAccountInput,
  type AccountRecord,
} from "../shared/domain/accounts.ts";
import type {
  SandboxConfig,
  SandboxProvider,
} from "../shared/domain/sandbox-config.ts";
import { requireEnv } from "../shared/env.ts";
import {
  errorResponse,
  jsonResponse,
  normalizePath,
  parseJsonBody,
  type CoreRequest,
} from "../shared/http.ts";
import { logDebug, logError, logWarn } from "../shared/log.ts";
import { isPlainObject } from "../shared/object.ts";
import { runWithObservabilityScope } from "../shared/otel.ts";
import { workspaceSandboxLimits } from "../shared/sandbox.ts";
import { getStorage } from "../shared/storage.ts";
import {
  sealTerminalTicket,
  TERMINAL_TICKET_TTL_MS,
  TERMINAL_WEBSOCKET_PATH,
} from "../shared/terminal-ticket.ts";
import {
  deleteAccountRuntimeData,
  deleteAccountSkills,
  deleteAccountToolBundles,
} from "./cleanup.ts";

type SandboxLifecycleAction =
  | "suspend"
  | "resume"
  | "terminate"
  | "snapshot"
  | "refresh"
  | "exec"
  | "terminal";

interface SandboxAuditDetails {
  durationMs?: number;
  errorMessage?: string;
  exitCode?: number | null;
  status?: SandboxInstanceStatus;
  truncated?: boolean;
}

/** Everything one lifecycle action needs, resolved once by the router. */
interface SandboxLifecycleContext {
  accountId: string;
  audit: (
    result: "ok" | "error",
    details?: SandboxAuditDetails,
  ) => Promise<void>;
  body: Record<string, unknown>;
  config: SandboxConfig;
  executor: SandboxExecutor;
  provider: SandboxProvider;
  ref: { reservationKey: string };
  reservationKey: string;
}

class AccountEndpointUnauthorizedError extends Error {
  constructor() {
    super("Unauthorized");
  }
}

export async function handler(request: CoreRequest): Promise<Response> {
  // Request-private observability scope so concurrent tenants in the shared
  // container process cannot clobber each other's log redaction/routing.
  return runWithObservabilityScope(() => handleAccountRequest(request));
}

async function handleAccountRequest(request: CoreRequest): Promise<Response> {
  const method = request.method;
  const rawPath = normalizePath(request.path);
  const headers = request.headers;

  try {
    logDebug("Account manage request received", {
      method: method,
      rawPath: rawPath,
    });

    if (method === "GET" && rawPath === "/") {
      return jsonResponse(200, { status: "ok" });
    }

    const auth = await resolveBearerAuth(headers, {
      // Cleanup can fail after the account is disabled. Permit only the
      // owning secret to retry self-deletion; all normal ingress remains
      // subject to the active-account requirement.
      allowDisabledAccountSecret:
        method === "DELETE" && rawPath === "/v1/account",
    });
    if (!auth) {
      logWarn("Account manage request unauthorized", {
        method: method,
        rawPath: rawPath,
      });

      return errorResponse(401, "Unauthorized");
    }

    if (method === "DELETE" && rawPath === "/v1/account") {
      const account = requireAccountAuth(auth);

      return deleteAccountResponse(account);
    }

    // Agent, skills, tools, hooks, workspace-file, cron, workspace, sandbox-config, and
    // policy CRUD moved to the Convex config plane (configHttp.ts, epic
    // #85 phase 9); the gateway routes those paths there. Runtime reads
    // stay in src/shared/skills.ts, uploaded tool bundle loading,
    // workspace mount/S3 read helpers, sandbox lifecycle verbs, and the
    // harness cron-run leaf; account deletion still sweeps leftover
    // schedules (deleteAccountCrons).

    const selfSandboxLifecycleMatch = rawPath.match(
      /^\/v1\/sandboxes\/([^/]+)\/(suspend|resume|terminate|snapshot|refresh|exec|terminal)$/,
    );
    if (selfSandboxLifecycleMatch?.[1] && selfSandboxLifecycleMatch[2]) {
      return await handleSandboxLifecycleRoute(
        auth,
        method,
        selfSandboxLifecycleMatch[1],
        selfSandboxLifecycleMatch[2] as SandboxLifecycleAction,
        request,
      );
    }

    if (auth.kind !== "admin") {
      return errorResponse(403, "Forbidden");
    }

    if (method === "POST" && rawPath === "/accounts") {
      const body = parseJsonBody(request);
      const created = await getStorage().accounts.create(
        normalizeCreateAccountInput(body),
      );

      return jsonResponse(201, {
        account: toCreateAccountResponse(created.account),
        secret: created.secret,
      });
    }

    const accountMatch = rawPath.match(/^\/accounts\/([^/]+)$/);
    if (accountMatch?.[1]) {
      const accountId = decodeURIComponent(accountMatch[1]);
      if (method === "DELETE") {
        const account = await getStorage().accounts.getById(accountId);
        if (!account) {
          return errorResponse(404, "Account not found");
        }

        return deleteAccountResponse(account);
      }
    }

    return errorResponse(404, "Not found");
  } catch (err) {
    logError("Account manage request failed", {
      method: method,
      rawPath: rawPath,
      error: errorText(err),
      errorName: err instanceof Error ? err.name : undefined,
      stack: err instanceof Error ? err.stack : undefined,
    });

    return errorResponseForError(err);
  }
}

/**
 * Auth gate for the sandbox lifecycle verbs: a role session must be allowed
 * `sandboxes:write` by its own policy.
 */
async function handleSandboxLifecycleRoute(
  auth: AuthContext,
  method: string,
  rawSandboxId: string,
  action: SandboxLifecycleAction,
  request: CoreRequest,
): Promise<Response> {
  if (auth.kind === "role") {
    const denial = roleDenial(rolePrincipal(auth.role), method, {
      type: "sandboxes",
      id: decodeURIComponent(rawSandboxId),
    });
    if (denial) return errorResponse(403, denial);

    return await handleSandboxLifecycle(
      method,
      auth.account.accountId,
      rawSandboxId,
      action,
      request,
    );
  }
  // Driven by the dashboard via the sandboxPublic Convex actions, which
  // authenticate with the shared service token.
  const account = requireAccountAuth(auth, { allowServiceToken: true });

  return await handleSandboxLifecycle(
    method,
    account.accountId,
    rawSandboxId,
    action,
    request,
  );
}

async function handleSandboxLifecycle(
  method: string,
  accountId: string,
  rawSandboxId: string,
  action: SandboxLifecycleAction,
  request: CoreRequest,
): Promise<Response> {
  if (method !== "POST") {
    return errorResponse(405, "Method not allowed", {
      method: method,
      allowedMethods: ["POST"],
    });
  }
  const sandboxId = decodeURIComponent(rawSandboxId);
  const record = await getStorage().sandboxConfigs.getById(
    accountId,
    sandboxId,
  );
  if (!record) {
    return errorResponse(404, "Sandbox not found");
  }

  const rawBody = parseJsonBody(request);
  const body = isPlainObject(rawBody) ? rawBody : {};
  const reservationKey =
    typeof body.reservationKey === "string" ? body.reservationKey.trim() : "";
  if (!reservationKey) {
    return errorResponse(400, "reservationKey is required");
  }
  // The registry row core wrote when it reserved the instance is the ownership record.
  // Deriving it from the config instead would strand a live sandbox the moment that
  // config changes (a CLI sync dropping `persistent`, a new `options.reservationKey`).
  if (
    !(await sandboxInstanceIsControllable(accountId, sandboxId, reservationKey))
  ) {
    return errorResponse(
      403,
      "reservationKey does not belong to this account or sandbox config",
    );
  }

  const actor = sandboxAuditActor(body.actor);
  const context: SandboxLifecycleContext = {
    accountId: accountId,
    audit: async (result, details = {}): Promise<void> => {
      await recordSandboxAuditEvent({
        accountId: accountId,
        sandboxConfigId: sandboxId,
        reservationKey: reservationKey,
        provider: record.config.provider,
        action: action,
        result: result,
        actor: actor,
        ...details,
      });
    },
    body: body,
    config: record.config,
    executor: createSandboxExecutor(record.config),
    provider: record.config.provider,
    ref: { reservationKey: reservationKey },
    reservationKey: reservationKey,
  };
  if (action === "exec") return execSandbox(context);
  if (action === "refresh") return refreshSandboxStatus(context);
  if (action === "resume") return suspendOrResumeSandbox(context, "resume");
  if (action === "snapshot") return snapshotSandbox(context);
  if (action === "suspend") return suspendOrResumeSandbox(context, "suspend");
  if (action === "terminal") return openSandboxTerminal(context);

  return terminateSandbox(context);
}

/** Runs one provider call, auditing and rethrowing its failure. */
async function auditedSandboxCall<T>(
  context: SandboxLifecycleContext,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (err) {
    await context.audit("error", { errorMessage: errorText(err) });
    throw err;
  }
}

async function execSandbox(
  context: SandboxLifecycleContext,
): Promise<Response> {
  const code = typeof context.body.code === "string" ? context.body.code : "";
  if (!code.trim()) {
    await context.audit("error", { errorMessage: "code is required" });

    return errorResponse(400, "code is required");
  }
  if (code.length > 20_000) {
    await context.audit("error", {
      errorMessage: "code must be 20000 characters or less",
    });

    return errorResponse(400, "code must be 20000 characters or less");
  }

  const limits = workspaceSandboxLimits(context.provider);
  const timeoutSeconds = boundedInteger(
    context.body.timeoutSeconds,
    context.config.timeout ?? limits.defaultTimeoutSeconds,
    limits.maxTimeoutSeconds,
  );
  const outputLimitBytes = boundedInteger(
    context.body.outputLimitBytes,
    context.config.outputLimitBytes ?? limits.defaultOutputLimitBytes,
    limits.maxOutputLimitBytes,
  );
  const result = await auditedSandboxCall(context, () =>
    context.executor.run({
      code: code,
      reservationKey: context.reservationKey,
      timeoutSeconds: timeoutSeconds,
      outputLimitBytes: outputLimitBytes,
    }),
  );
  await setSandboxInstanceStatus(
    context.accountId,
    context.reservationKey,
    "running",
  );
  await context.audit(result.ok ? "ok" : "error", {
    status: "running",
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    truncated: result.truncated === true,
  });

  return jsonResponse(200, {
    ok: result.ok,
    runtime: result.runtime,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
    truncated: result.truncated === true,
    provider: result.provider,
  });
}

async function openSandboxTerminal(
  context: SandboxLifecycleContext,
): Promise<Response> {
  // workdir exposes an in-guest PTY WebSocket; AWS MicroVMs expose the native
  // shell endpoint (SHELL_INGRESS). Other providers keep the bounded `exec`
  // terminal.
  if (context.provider !== "sandbox" && context.provider !== "lambda") {
    return unsupportedSandboxAction(context, "a live terminal");
  }
  const externalId = await getSandboxExternalId(
    context.provider,
    context.reservationKey,
  );
  if (!externalId) {
    await context.audit("error", {
      errorMessage: "No reserved sandbox instance for this reservation key",
    });

    return errorResponse(
      404,
      "No reserved sandbox instance for this reservation key",
    );
  }
  // The PTY endpoint requires a running guest, so opening a terminal
  // resumes a suspended instance the same way an exec would.
  if (context.executor.getInstanceInfo && context.executor.resume) {
    const info = await context.executor.getInstanceInfo(context.ref);
    if (info?.state === "suspended") {
      await auditedSandboxCall(context, async () => {
        await context.executor.resume?.(context.ref);
      });
      await setSandboxInstanceStatus(
        context.accountId,
        context.reservationKey,
        "running",
      );
    }
  }
  let target: {
    url: string;
    authorization: string;
    authorizationHeader?: string;
  };
  if (context.provider === "lambda") {
    try {
      const shell = await microvmShellConnection(externalId);
      target = { ...shell, authorizationHeader: MICROVM_SHELL_AUTH_HEADER };
    } catch (error) {
      // Most likely a VM launched before SHELL_INGRESS was attached at
      // RunMicrovm; connectors cannot be added to a live VM.
      const message = errorText(error);
      await context.audit("error", { errorMessage: message });

      return errorResponse(
        409,
        `MicroVM shell access unavailable (${message}); terminate and re-reserve the instance to enable the live terminal`,
      );
    }
  } else {
    const { baseUrl, apiKey } = workdirConnection(context.config);
    target = {
      url: workdirPtyUrl(baseUrl, externalId),
      authorization: `Bearer ${apiKey}`,
    };
  }
  const expiresAt = Date.now() + TERMINAL_TICKET_TTL_MS;
  const token = sealTerminalTicket(
    { ...target, accountId: context.accountId, expiresAt: expiresAt },
    requireEnv("SERVICE_AUTH_SECRET"),
  );
  await context.audit("ok", { status: "running" });

  return jsonResponse(200, {
    token: token,
    expiresAt: expiresAt,
    websocketPath: TERMINAL_WEBSOCKET_PATH,
  });
}

async function refreshSandboxStatus(
  context: SandboxLifecycleContext,
): Promise<Response> {
  if (!context.executor.getInstanceInfo) {
    return unsupportedSandboxAction(context, "instance status refresh");
  }
  const info = await auditedSandboxCall(context, async () =>
    context.executor.getInstanceInfo?.(context.ref),
  );
  if (!info || info.state === "terminating") {
    await removeSandboxInstance(context.accountId, context.reservationKey);
    await context.audit("ok", { status: "terminating" });

    return jsonResponse(200, { status: "terminated" });
  }
  const status = info.state === "unknown" ? "error" : info.state;
  // A refresh reads the provider's state; it does not use the sandbox.
  await setSandboxInstanceStatus(
    context.accountId,
    context.reservationKey,
    status,
    true,
  );
  await context.audit(status === "error" ? "error" : "ok", { status: status });

  return jsonResponse(200, { status: status, externalId: info.externalId });
}

async function snapshotSandbox(
  context: SandboxLifecycleContext,
): Promise<Response> {
  if (!context.executor.snapshot) {
    return unsupportedSandboxAction(context, "snapshot");
  }
  const name =
    typeof context.body.name === "string" ? context.body.name.trim() : "";
  if (!name) {
    await context.audit("error", { errorMessage: "name is required" });

    return errorResponse(400, "name is required");
  }
  // The assertion is safe under the guard above; calling through the executor
  // keeps its `this` binding.
  const result = await auditedSandboxCall(context, async () =>
    context.executor.snapshot!(context.ref),
  );
  const externalImageId = result.externalImageId ?? result.snapshotId;
  await upsertSandboxSnapshot({
    accountId: context.accountId,
    name: name,
    provider: context.provider,
    baseImage: context.provider,
    externalImageId: externalImageId,
    status: "active",
  });
  await context.audit("ok", { status: "running" });

  return jsonResponse(200, {
    status: "active",
    snapshotId: result.snapshotId,
    externalImageId: externalImageId,
  });
}

async function suspendOrResumeSandbox(
  context: SandboxLifecycleContext,
  action: "suspend" | "resume",
): Promise<Response> {
  const supported =
    action === "suspend" ? context.executor.suspend : context.executor.resume;
  if (!supported) {
    return unsupportedSandboxAction(context, action);
  }
  await auditedSandboxCall(context, async () => {
    if (action === "suspend") await context.executor.suspend?.(context.ref);
    else await context.executor.resume?.(context.ref);
  });
  const status = action === "suspend" ? "suspended" : "running";
  await setSandboxInstanceStatus(
    context.accountId,
    context.reservationKey,
    status,
  );
  await context.audit("ok", { status: status });

  return jsonResponse(200, { status: status });
}

async function terminateSandbox(
  context: SandboxLifecycleContext,
): Promise<Response> {
  if (!context.executor.release) {
    return unsupportedSandboxAction(context, "terminate");
  }
  await auditedSandboxCall(context, async () => {
    await context.executor.release?.(context.ref);
  });
  await removeSandboxInstance(context.accountId, context.reservationKey);
  await context.audit("ok", { status: "terminating" });

  return jsonResponse(200, { status: "terminated" });
}

async function unsupportedSandboxAction(
  context: SandboxLifecycleContext,
  capability: string,
): Promise<Response> {
  const message = `provider ${context.provider} does not support ${capability}`;
  await context.audit("error", { errorMessage: message });

  return errorResponse(409, message);
}

async function deleteAccountResponse(
  account: Extract<AuthContext, { kind: "account" }>["account"],
): Promise<Response> {
  const disabled =
    account.status === "disabled"
      ? account
      : await getStorage().accounts.disable(account.accountId);
  if (!disabled) {
    return jsonResponse(404, { error: "Account not found" });
  }

  const [
    runtime,
    agentsDeleted,
    skillObjectsDeleted,
    toolBundleObjectsDeleted,
    cronsDeleted,
    accountToolsDeleted,
    accountHooksDeleted,
    mcpDeleted,
    channelRecordsDeleted,
  ] = await Promise.all([
    deleteAccountRuntimeData(disabled),
    getStorage().agents.removeAllForAccount(account.accountId),
    deleteAccountSkills(account.accountId),
    deleteAccountToolBundles(account.accountId),
    deleteAccountCrons(account.accountId),
    getStorage().accountTools.removeAllForAccount(account.accountId),
    getStorage().accountHooks.removeAllForAccount(account.accountId),
    getStorage().mcp.removeAllForAccount(account.accountId),
    getStorage().channelRecords.removeAllForAccount(account.accountId),
  ]);
  await getStorage().accounts.remove(account.accountId);

  return jsonResponse(200, {
    deleted: true,
    cleanup: {
      ...runtime,
      agentsDeleted: agentsDeleted,
      skillObjectsDeleted: skillObjectsDeleted,
      toolBundleObjectsDeleted: toolBundleObjectsDeleted,
      cronsDeleted: cronsDeleted,
      accountToolsDeleted: accountToolsDeleted,
      accountHooksDeleted: accountHooksDeleted,
      mcpDeleted: mcpDeleted,
      channelRecordsDeleted: channelRecordsDeleted,
    },
  });
}

async function deleteAccountCrons(accountId: string): Promise<number> {
  const cronsStore = getStorage().crons;
  const crons = await cronsStore.list(accountId);
  await Promise.all(
    crons.map((cron) => cronsStore.remove(accountId, cron.cronId)),
  );

  return crons.length;
}

function requireAccountAuth(
  auth: AuthContext,
  options: { allowServiceToken?: boolean; allowDeployment?: boolean } = {},
): Extract<AuthContext, { kind: "account" }>["account"] {
  if (auth.kind === "deployment" && options.allowDeployment === true) {
    return auth.account;
  }
  if (auth.kind === "deployment" || auth.kind === "role") {
    throw new AccountEndpointUnauthorizedError();
  }
  if (auth.kind !== "account") {
    throw new Error("Admin must use account-specific endpoints");
  }
  if (auth.viaServiceToken && options.allowServiceToken !== true) {
    throw new Error("Service token is not allowed for this account endpoint");
  }

  return auth.account;
}

function toCreateAccountResponse(
  account: AccountRecord,
): Record<string, unknown> {
  return {
    accountId: account.accountId,
    username: account.username,
    ...(account.description ? { description: account.description } : {}),
  };
}

function boundedInteger(
  value: unknown,
  defaultValue: number,
  max: number,
): number {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    return defaultValue;
  }

  return parsed;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sandboxAuditActor(value: unknown): SandboxAuditActor {
  if (!isPlainObject(value)) {
    return { source: "unknown" };
  }
  const source =
    value.source === "dashboard" ||
    value.source === "agent" ||
    value.source === "service"
      ? value.source
      : "unknown";

  return {
    source: source,
    ...(typeof value.id === "string" && value.id.trim()
      ? { id: value.id.trim() }
      : {}),
    ...(typeof value.email === "string" && value.email.trim()
      ? { email: value.email.trim() }
      : {}),
    ...(typeof value.name === "string" && value.name.trim()
      ? { name: value.name.trim() }
      : {}),
  };
}

function errorResponseForError(err: unknown): Response {
  if (err instanceof AccountEndpointUnauthorizedError) {
    return errorResponse(401, err.message);
  }

  return errorResponse(
    400,
    err instanceof Error ? err.message : "Invalid request",
  );
}
