/**
 * Storage with `my-mac` and `other-mac` machine records and a `cloud-box` lambda
 * record, and a core server that serves only the daemon socket. `other-mac` is
 * `bypass` so a test can tell two machines' approval apart.
 */

import {
  isMachineUpgrade,
  machineWebSocketHandler,
  upgradeMachineSocket,
  type MachineSocketData,
} from "../../src/harness/sandbox/machine-executor.ts";
import type { SandboxExecutorConfig } from "../../src/harness/sandbox/types.ts";
import type { AccountRecord } from "../../src/shared/domain/accounts.ts";
import type { McpRecord } from "../../src/shared/domain/mcp.ts";
import type { SandboxConfigRecord } from "../../src/shared/domain/sandbox-config.ts";
import type {
  MachineConnectionRecord,
  MachineConnectionRef,
  Storage,
} from "../../src/shared/storage.ts";

export const MACHINE_ACCOUNT_ID = "acct_machine";
export const MACHINE_RUNTIME_KEY = "runtime-key";
/** A role session whose policy reads sandboxes and nothing more. */
export const MACHINE_READ_ONLY_ROLE_TOKEN = "fp_sts_read-only";
export const MACHINE_SANDBOX_ID = "sbx_machine";
export const OTHER_MACHINE_SANDBOX_ID = "sbx_machine_other";

/** One connection status write core sent to storage. */
export type MachineConnectionWrite =
  | { kind: "connected"; ref: MachineConnectionRecord }
  | { kind: "disconnected" | "seen"; ref: MachineConnectionRef };

export function closeOf(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve): void => {
    socket.onclose = resolve;
  });
}

/** The executor config core builds for the `my-mac` record. */
export function machineExecutorConfig(
  overrides: Partial<SandboxExecutorConfig> = {},
): SandboxExecutorConfig {
  return {
    provider: "machine",
    controlPlane: {
      accountId: MACHINE_ACCOUNT_ID,
      sandboxConfigId: MACHINE_SANDBOX_ID,
      name: "my-mac",
      specs: { vcpu: 0, memoryMb: 0, storageGb: 0 },
    },
    ...overrides,
  };
}

/** An `echo` MCP row served by the `my-mac` daemon. */
export function machineMcpRecord(): McpRecord {
  return {
    accountId: MACHINE_ACCOUNT_ID,
    serverId: "mcp_echo",
    projectId: "proj",
    stageId: "stage",
    name: "echo",
    transport: "machine",
    sandbox: "my-mac",
    status: "active",
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  };
}

/** Connection status writes land in `writes`. */
export function machineStorage(writes: MachineConnectionWrite[] = []): Storage {
  const account: AccountRecord = {
    accountId: MACHINE_ACCOUNT_ID,
    username: "machine",
    secretHash: "hash",
    status: "active",
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  };
  const records: SandboxConfigRecord[] = [
    {
      accountId: MACHINE_ACCOUNT_ID,
      sandboxId: MACHINE_SANDBOX_ID,
      name: "my-mac",
      config: {
        provider: "machine",
        permissionMode: "ask",
        network: { mode: "allow-all" },
      },
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    },
    {
      accountId: MACHINE_ACCOUNT_ID,
      sandboxId: OTHER_MACHINE_SANDBOX_ID,
      name: "other-mac",
      config: {
        provider: "machine",
        permissionMode: "bypass",
        network: { mode: "allow-all" },
      },
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    },
    {
      accountId: MACHINE_ACCOUNT_ID,
      sandboxId: "sbx_cloud",
      name: "cloud-box",
      config: {
        provider: "lambda",
        permissionMode: "ask",
        network: { mode: "deny-all" },
      },
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    },
  ];
  const runtimeKeyHash = new Bun.CryptoHasher("sha256")
    .update(MACHINE_RUNTIME_KEY)
    .digest("hex");
  const readOnlyRoleHash = new Bun.CryptoHasher("sha256")
    .update(MACHINE_READ_ONLY_ROLE_TOKEN)
    .digest("hex");

  return {
    roleSessions: {
      resolveByTokenHash: async (hash: string) =>
        hash === readOnlyRoleHash
          ? {
              accountId: MACHINE_ACCOUNT_ID,
              roleId: "role_read",
              policy: {
                version: 1,
                mode: "enforce",
                rules: [
                  { id: "read", effect: "allow", actions: ["sandboxes:read"] },
                ],
              },
            }
          : null,
    },
    accounts: {
      getById: async (accountId: string) =>
        accountId === MACHINE_ACCOUNT_ID ? account : null,
      getBySecretHash: async () => null,
    },
    agentDeployments: {
      getByApiKeyHash: async (hash: string) =>
        hash === runtimeKeyHash
          ? {
              accountId: MACHINE_ACCOUNT_ID,
              endpointId: "endpoint",
              projectSlug: "demo",
              stageSlug: "development",
            }
          : null,
    },
    machineConnections: {
      connected: async (connection: MachineConnectionRecord): Promise<void> => {
        writes.push({ kind: "connected", ref: connection });
      },
      disconnected: async (ref: MachineConnectionRef): Promise<void> => {
        writes.push({ kind: "disconnected", ref: ref });
      },
      seen: async (ref: MachineConnectionRef): Promise<void> => {
        writes.push({ kind: "seen", ref: ref });
      },
    },
    sandboxConfigs: {
      getById: async (_accountId: string, sandboxId: string) =>
        records.find((record) => record.sandboxId === sandboxId) ?? null,
      list: async () => records,
      removeAllForAccount: async () => 0,
    },
  } as unknown as Storage;
}

/** The executor config core builds for the `other-mac` record. */
export function otherMachineExecutorConfig(
  overrides: Partial<SandboxExecutorConfig> = {},
): SandboxExecutorConfig {
  return machineExecutorConfig({
    controlPlane: {
      accountId: MACHINE_ACCOUNT_ID,
      sandboxConfigId: OTHER_MACHINE_SANDBOX_ID,
      name: "other-mac",
      specs: { vcpu: 0, memoryMb: 0, storageGb: 0 },
    },
    ...overrides,
  });
}

export function startMachineCore(): Bun.Server<MachineSocketData> {
  return Bun.serve<MachineSocketData>({
    port: 0,
    fetch: (request, bunServer) =>
      isMachineUpgrade(request)
        ? upgradeMachineSocket(request, bunServer)
        : new Response("not found", { status: 404 }),
    websocket: machineWebSocketHandler,
  });
}

export async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
