/**
 * Fixtures for core's machine sandbox tests: storage with one account, its
 * runtime key, a machine record and a cloud record, plus a core server that
 * serves only the daemon socket.
 */

import {
  isMachineUpgrade,
  machineWebSocketHandler,
  upgradeMachineSocket,
  type MachineSocketData,
} from "../../src/harness/sandbox/machine-executor.ts";
import type { SandboxExecutorConfig } from "../../src/harness/sandbox/types.ts";
import type { AccountRecord } from "../../src/shared/domain/accounts.ts";
import type { SandboxConfigRecord } from "../../src/shared/domain/sandbox-config.ts";
import type { Storage } from "../../src/shared/storage.ts";

export const MACHINE_ACCOUNT_ID = "acct_machine";
export const MACHINE_RUNTIME_KEY = "runtime-key";
export const MACHINE_SANDBOX_ID = "sbx_machine";

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

export function machineStorage(): Storage {
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

  return {
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
    sandboxConfigs: {
      getById: async (_accountId: string, sandboxId: string) =>
        records.find((record) => record.sandboxId === sandboxId) ?? null,
      list: async () => records,
      removeAllForAccount: async () => 0,
    },
  } as unknown as Storage;
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
