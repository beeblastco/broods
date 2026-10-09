"use client";

import type { MachineConnection } from "@/app/lib/machineConnection";
import type { Doc, Id } from "@broods/convex/_generated/dataModel";
import { SandboxInstancesTable } from "../(main)/[projectId]/sandbox/components/SandboxInstancesTable";

const NOW = Date.now();
const MINUTE = 60_000;
const PROJECT_ID = "p57cse242n9pww5nknkyzpk1w98fw859" as Id<"projects">;
const ACCOUNT_ID = "a00000000000000000000000000000001" as Id<"accounts">;
const CONFIG_ID = "c00000000000000000000000000000001" as Id<"sandboxConfigs">;

/** A cloud instance with the facts a row and its panel read; `patch` sets the rest. */
function instance(
  id: string,
  patch: Partial<Doc<"sandboxInstances">> & {
    name: string;
    provider: Doc<"sandboxInstances">["provider"];
    status: Doc<"sandboxInstances">["status"];
  },
): Doc<"sandboxInstances"> {
  return {
    _id: id as Id<"sandboxInstances">,
    _creationTime: NOW - 60 * MINUTE,
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    reservationKey: `rk_${id}`,
    sandboxConfigId: CONFIG_ID,
    externalId: `sbx_${id}9f2e71c4`,
    specs: { vcpu: 2, memoryMb: 4096, storageGb: 10 },
    specsVerified: true,
    createdAt: NOW - 14 * MINUTE,
    lastUsedAt: NOW - 0.1 * MINUTE,
    ...patch,
  };
}

const INSTANCES: Doc<"sandboxInstances">[] = [
  instance("s1", {
    name: "code-runner",
    provider: "lambda",
    status: "running",
    agentId: "agent-triage",
    conversationKey: "slack:C04/triage",
    createdByTraceId: "a91f3c8e4b2d7e6f0c1a2b3c4d5e6f70",
    lastUsedTraceId: "c0de41b7a91f3c8e4b2d7e6f0c1a2b3c",
    logStream: "acct/project/stage/4f2c9d1e-7a3b-4c5d-8e9f-0a1b2c3d4e5f/mac",
    snapshotId: "snap-python-base-3",
  }),
  instance("s2", {
    name: "browser",
    provider: "cloudflare",
    status: "suspended",
    specs: { vcpu: 1, memoryMb: 2048 },
    agentId: "agent-support",
    createdAt: NOW - 120 * MINUTE,
    lastUsedAt: NOW - 60 * MINUTE,
    suspendedAt: NOW - 59 * MINUTE,
    lastUsedTraceId: "77be02d1a91f3c8e4b2d7e6f0c1a2b3c",
  }),
  instance("s3", {
    name: "data-lab",
    provider: "lambda",
    status: "error",
    errorMessage: "guest exited 137",
    specs: { vcpu: 4, memoryMb: 8192, storageGb: 20 },
    agentId: "agent-reporter",
    createdAt: NOW - 1440 * MINUTE,
    lastUsedAt: NOW - 1440 * MINUTE,
    lastUsedTraceId: "f00d19aaa91f3c8e4b2d7e6f0c1a2b3c",
  }),
  instance("s4", {
    name: "scratch",
    provider: "e2b",
    status: "running",
    ephemeral: true,
    specs: { vcpu: 2, memoryMb: 512 },
    createdAt: NOW - 6 * MINUTE,
    lastUsedAt: NOW - 1 * MINUTE,
  }),
];

const MACHINES: MachineConnection[] = [
  {
    _id: "m00000000000000000000000000000001" as Id<"machineConnections">,
    _creationTime: NOW - 300 * MINUTE,
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    sandboxConfigId: CONFIG_ID,
    connectionId: "conn-1",
    hostname: "phicks-mbp.local",
    platform: "darwin",
    computer: true,
    mcp: [],
    specs: { vcpu: 10, memoryMb: 32768 },
    connectedAt: NOW - 300 * MINUTE,
    lastSeenAt: NOW,
    name: "phicks-mbp",
  },
];

const AGENTS = [
  { _id: "agent-triage" as Id<"agents">, name: "triage" },
  { _id: "agent-support" as Id<"agents">, name: "support-bot" },
  { _id: "agent-reporter" as Id<"agents">, name: "reporter" },
];

const SNAPSHOTS: Doc<"sandboxSnapshots">[] = [
  {
    _id: "snap-python-base-3" as Id<"sandboxSnapshots">,
    _creationTime: NOW - 1500 * MINUTE,
    accountId: ACCOUNT_ID,
    name: "python-base@3",
    provider: "lambda",
    baseImage: "python:3.13",
    status: "active",
    externalImageId: "ami-0123456789abcdef0",
    pulledCount: 4,
    createdAt: NOW - 1500 * MINUTE,
    lastUsedAt: NOW - 14 * MINUTE,
  },
];

/**
 * The sandbox list with cloud instances in every state and a connected
 * computer, so a spec can open the panel and the dock with no provider behind
 * them. Actions that need the backend (connect, snapshot, terminate) fail
 * here, which is fine: the fixture is about layout.
 */
export function SandboxInstancesStandIn(): React.JSX.Element {
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <SandboxInstancesTable
        instances={INSTANCES}
        machines={MACHINES}
        agents={AGENTS}
        snapshots={SNAPSHOTS}
        projectId={PROJECT_ID}
        observability={null}
      />
    </div>
  );
}
