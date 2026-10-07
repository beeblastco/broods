import { afterEach, describe, expect, it } from "bun:test";
import { ingestChannelAttachments } from "../src/harness/session.ts";
import { normalizeFilesystemNamespace } from "../src/shared/runtime-keys.ts";
import {
  agentSandboxReservation,
  agentSandboxReservationKey,
  isolatedWorkspaceNamespace,
  pinnedSandboxReservationKey,
  resolveAgentRuntime,
  runsOnOwnCredentials,
  workspaceNamespace,
} from "../src/shared/workspaces.ts";
import { setStorageForTests } from "../src/shared/storage.ts";

// A bring-your-own bucket, as workspace config validation accepts it.
const OWN_BUCKET_STORAGE = {
  provider: "s3",
  bucket: "dev-bucket",
  prefix: "agents/",
  auth: {
    type: "assumeRole",
    roleArn: "arn:aws:iam::123456789012:role/broods-mount",
  },
};

afterEach(() => {
  setStorageForTests(null);
});

describe("workspaceNamespace", () => {
  it("scopes by accountId:workspaceId so the workspace is shared across agents", () => {
    expect(workspaceNamespace("acct_1", "ws_a")).toBe(
      normalizeFilesystemNamespace("acct_1:ws_a"),
    );
    expect(workspaceNamespace("acct_1", "ws_a")).not.toBe(
      workspaceNamespace("acct_1", "ws_b"),
    );
    // Same workspaceId resolves to the same namespace regardless of caller.
    expect(workspaceNamespace("acct_1", "ws_a")).toBe(
      workspaceNamespace("acct_1", "ws_a"),
    );
  });

  it("mounts channel scope at the workspace root and conversation scope under its alias", () => {
    const base = workspaceNamespace("acct_1", "ws_a");
    const scope = {
      channelName: "github",
      channelScopeKey: "slack:T123:C456",
      conversationKey: "slack:T123:C456:1719760000.000000",
      partition: { by: "shared" as const },
    };

    expect(isolatedWorkspaceNamespace(base, undefined, scope)).toBe(base);
    expect(isolatedWorkspaceNamespace(base, "conversation")).toBe(base);
    expect(isolatedWorkspaceNamespace(base, "conversation", scope)).toBe(base);
    expect(
      isolatedWorkspaceNamespace(base, "conversation", {
        ...scope,
        partition: { alias: "support", by: "conversation" },
      }),
    ).toBe(
      `${base}/support/${normalizeFilesystemNamespace(scope.conversationKey)}`,
    );
    expect(() =>
      isolatedWorkspaceNamespace(base, "conversation", {
        channelName: "slack",
      }),
    ).toThrow(
      "Workspace isolation requires the active channel to define partition",
    );
  });

  it("gives each agent its own folder under agent isolation, shared across its conversations", () => {
    const base = workspaceNamespace("acct_1", "ws_a");
    const conversationA = {
      agentId: "agent_1",
      channelName: "github",
      channelScopeKey: "gh:owner/repo",
      conversationKey: "gh:owner/repo:issue:1",
      partition: { alias: "support", by: "conversation" as const },
    };
    const conversationB = {
      ...conversationA,
      conversationKey: "gh:owner/repo:issue:2",
    };
    const agentOne = isolatedWorkspaceNamespace(base, "agent", conversationA);

    expect(agentOne).toBe(
      `${base}/agent/${normalizeFilesystemNamespace("agent_1")}`,
    );
    expect(isolatedWorkspaceNamespace(base, "agent", conversationB)).toBe(
      agentOne,
    );
    expect(
      isolatedWorkspaceNamespace(base, "agent", {
        ...conversationA,
        agentId: "agent_2",
      }),
    ).not.toBe(agentOne);
    expect(() => isolatedWorkspaceNamespace(base, "agent", {})).toThrow(
      'Workspace isolation "agent" requires an agent identity',
    );
  });

  it("shares channel roots while separating aliased sibling conversations", () => {
    const base = workspaceNamespace("acct_1", "ws_a");
    const parentScope = {
      channelName: "slack",
      channelScopeKey: "slack:T123:C456",
      conversationKey: "slack:T123:C456:1719760000.000000",
      partition: { by: "shared" as const },
    };
    const sameAliasParent = {
      ...parentScope,
      channelName: "discord",
      channelScopeKey: "discord:G1:C456",
      conversationKey: "discord:G1:C456",
    };
    const firstIssue = {
      ...parentScope,
      channelName: "github",
      channelScopeKey: "gh:owner/repo",
      conversationKey: "gh:owner/repo:issue:123",
      partition: { alias: "support", by: "conversation" as const },
    };
    const secondIssue = {
      ...firstIssue,
      conversationKey: "gh:owner/repo:issue:456",
    };

    expect(isolatedWorkspaceNamespace(base, "conversation", parentScope)).toBe(
      isolatedWorkspaceNamespace(base, "conversation", sameAliasParent),
    );
    expect(isolatedWorkspaceNamespace(base, "conversation", firstIssue)).toBe(
      `${base}/support/${normalizeFilesystemNamespace("gh:owner/repo:issue:123")}`,
    );
    expect(
      isolatedWorkspaceNamespace(base, "conversation", firstIssue),
    ).not.toBe(isolatedWorkspaceNamespace(base, "conversation", secondIssue));
  });
});

describe("agentSandboxReservationKey", () => {
  it("scopes a reserved agent sandbox by account, agent and sandbox record", () => {
    const key = agentSandboxReservationKey("acct_1", "ag_1", "sb_1");
    expect(key).toBe(normalizeFilesystemNamespace("acct_1:ag_1:sb_1"));
    // Every segment is load bearing: no accidental sharing between agents or
    // across sandbox records.
    expect(key).not.toBe(agentSandboxReservationKey("acct_2", "ag_1", "sb_1"));
    expect(key).not.toBe(agentSandboxReservationKey("acct_1", "ag_2", "sb_1"));
    expect(key).not.toBe(agentSandboxReservationKey("acct_1", "ag_1", "sb_2"));
    // Nothing else in the system may collide with a workspace's reservation key.
    expect(key).not.toBe(workspaceNamespace("acct_1", "sb_1"));
  });
});

describe("runsOnOwnCredentials", () => {
  it("treats a blank credential as the platform's, as the executors do", () => {
    // The executors trim a blank key away and run on platform keys, so it is billed.
    expect(
      runsOnOwnCredentials({ provider: "e2b", options: { apiKey: " " } }),
    ).toBe(false);
    expect(
      runsOnOwnCredentials({ provider: "vercel", options: { token: "\t" } }),
    ).toBe(false);
    expect(
      runsOnOwnCredentials({ provider: "daytona", options: { apiKey: "key" } }),
    ).toBe(true);
  });
});

describe("agentSandboxReservation", () => {
  // Account deletion asks this same question; a rule that disagreed with the
  // runtime would leave machines running at the provider.
  const persistent = { provider: "sandbox", persistent: true } as const;

  it("derives a key for a persistent sandbox", () => {
    expect(agentSandboxReservation(persistent, "acct_1", "ag_1", "sb_1")).toBe(
      agentSandboxReservationKey("acct_1", "ag_1", "sb_1"),
    );
  });

  it("scopes a pinned key to its account rather than passing it raw", () => {
    const pinned = {
      ...persistent,
      options: { reservationKey: "team-shared" },
    };
    expect(agentSandboxReservation(pinned, "acct_1", "ag_1", "sb_1")).toBe(
      pinnedSandboxReservationKey("acct_1", "team-shared"),
    );
    // Raw pinned text must never reach the registry: the lookup is not
    // account-checked, so an unscoped key could name another account's machine.
    expect(agentSandboxReservation(pinned, "acct_1", "ag_1", "sb_1")).not.toBe(
      "team-shared",
    );
    expect(pinnedSandboxReservationKey("acct_1", "team-shared")).not.toBe(
      pinnedSandboxReservationKey("acct_2", "team-shared"),
    );
    // Nor may a pinned string collide with a key the runtime derives itself.
    expect(
      agentSandboxReservation(
        { ...persistent, options: { reservationKey: "ag_1:sb_1" } },
        "acct_1",
        "ag_1",
        "sb_1",
      ),
    ).not.toBe(agentSandboxReservationKey("acct_1", "ag_1", "sb_1"));
  });

  it("reserves nothing without persistence or an identity to derive from", () => {
    expect(
      agentSandboxReservation(
        { provider: "sandbox" },
        "acct_1",
        "ag_1",
        "sb_1",
      ),
    ).toBeUndefined();
    expect(
      agentSandboxReservation(persistent, undefined, "ag_1", "sb_1"),
    ).toBeUndefined();
    expect(
      agentSandboxReservation(persistent, "acct_1", undefined, "sb_1"),
    ).toBeUndefined();
  });
});

describe("resolveAgentRuntime", () => {
  it("marks only sandboxes on the account's own credentials as unmetered", async () => {
    const configs: Record<string, Record<string, unknown>> = {
      own_daytona: { provider: "daytona", options: { apiKey: "dtn_own" } },
      platform_daytona: { provider: "daytona" },
      own_vercel: { provider: "vercel", options: { token: "vc_own" } },
      own_workdir: {
        provider: "sandbox",
        options: { workdirUrl: "https://workdir.example.com", apiKey: "k" },
      },
      microvm: { provider: "lambda" },
    };
    setStorageForTests({
      sandboxConfigs: {
        getById: async (_accountId: string, id: string) => ({
          sandboxId: id,
          name: id,
          config: configs[id],
        }),
      },
    } as never);

    const resolved = await resolveAgentRuntime(
      { sandboxes: Object.keys(configs) },
      { accountId: "acct_1" },
    );

    expect(
      Object.fromEntries(
        resolved.sandboxes.map((entry) => [
          entry.name,
          entry.sandbox.controlPlane?.ownCredentials === true,
        ]),
      ),
    ).toEqual({
      own_daytona: true,
      platform_daytona: false,
      own_vercel: true,
      own_workdir: true,
      microvm: false,
    });
  });

  it("resolves sandbox + workspace references through storage", async () => {
    setStorageForTests({
      sandboxConfigs: {
        getById: async (_accountId: string, id: string) =>
          id === "sb_1"
            ? {
                sandboxId: "sb_1",
                name: "primary",
                config: {
                  provider: "lambda",
                  permissionMode: "ask",
                  snapshot: "img_primary",
                },
              }
            : null,
      },
      workspaceConfigs: {
        getById: async (_accountId: string, id: string) =>
          id === "ws_a"
            ? {
                config: { storage: { provider: "s3" } },
                description: "notes ws",
              }
            : null,
      },
    } as never);

    const resolved = await resolveAgentRuntime(
      {
        sandboxes: ["sb_1"],
        workspaces: [{ name: "notes", workspaceId: "ws_a" }],
      },
      { accountId: "acct_1" },
    );

    expect(resolved.sandboxes).toEqual([
      {
        name: "primary",
        sandbox: expect.objectContaining({
          provider: "lambda",
          permissionMode: "ask",
        }),
      },
    ]);
    // The workspace inherits the agent-level sandbox as its effective sandbox, with
    // its own storage identity attached so the executor resolves the mount target, plus
    // the control-plane identity so a reserved instance can mirror itself into Convex.
    expect(resolved.workspaces).toEqual([
      {
        name: "notes",
        workspaceId: "ws_a",
        namespace: workspaceNamespace("acct_1", "ws_a"),
        description: "notes ws",
        config: { storage: { provider: "s3" } },
        sandbox: {
          provider: "lambda",
          permissionMode: "ask",
          snapshot: "img_primary",
          storage: { provider: "s3" },
          controlPlane: {
            accountId: "acct_1",
            sandboxConfigId: "sb_1",
            name: "primary",
            specs: { vcpu: 0.5, memoryMb: 1024, storageGb: 8 },
            snapshotId: "img_primary",
            permissionMode: "ask",
            idleTimeoutSeconds: 900,
          },
        },
      },
    ]);
  });

  it("resolves workspace isolation with the active channel workspace scope", async () => {
    setStorageForTests({
      sandboxConfigs: { getById: async () => null },
      workspaceConfigs: {
        getById: async (_accountId: string, id: string) =>
          id === "ws_a"
            ? {
                config: {
                  storage: { provider: "s3" },
                  isolation: "conversation",
                },
              }
            : null,
      },
    } as never);

    const resolved = await resolveAgentRuntime(
      { workspaces: [{ name: "notes", workspaceId: "ws_a" }] },
      { accountId: "acct_1" },
      {
        channelName: "github",
        channelScopeKey: "gh:owner/repo",
        conversationKey: "gh:owner/repo:issue:123",
        partition: { alias: "support", by: "conversation" },
      },
    );

    const base = workspaceNamespace("acct_1", "ws_a");
    expect(resolved.workspaces[0]?.namespace).toBe(
      `${base}/support/${normalizeFilesystemNamespace("gh:owner/repo:issue:123")}`,
    );
  });

  it("resolves isolated workspaces at the root for non-channel runs", async () => {
    setStorageForTests({
      sandboxConfigs: { getById: async () => null },
      workspaceConfigs: {
        getById: async (_accountId: string, id: string) =>
          id === "ws_a"
            ? {
                config: {
                  storage: { provider: "s3" },
                  isolation: "conversation",
                },
              }
            : null,
      },
    } as never);

    const resolved = await resolveAgentRuntime(
      { workspaces: [{ name: "notes", workspaceId: "ws_a" }] },
      { accountId: "acct_1" },
    );

    expect(resolved.workspaces[0]?.namespace).toBe(
      workspaceNamespace("acct_1", "ws_a"),
    );
  });

  it("resolves an agent-isolated workspace to the agent's own namespace", async () => {
    setStorageForTests({
      sandboxConfigs: { getById: async () => null },
      workspaceConfigs: {
        getById: async (_accountId: string, id: string) =>
          id === "ws_a"
            ? { config: { storage: { provider: "s3" }, isolation: "agent" } }
            : null,
      },
    } as never);
    const agentConfig = {
      workspaces: [{ name: "notes", workspaceId: "ws_a" }],
    };
    const resolve = (
      agentId: string,
      conversationKey: string,
    ): ReturnType<typeof resolveAgentRuntime> =>
      resolveAgentRuntime(
        agentConfig,
        { accountId: "acct_1", agentId: agentId },
        {
          channelName: "github",
          channelScopeKey: "gh:owner/repo",
          conversationKey: conversationKey,
          partition: { alias: "support", by: "conversation" },
        },
      );

    const [one, oneAgain, two] = await Promise.all([
      resolve("agent_1", "gh:owner/repo:issue:1"),
      resolve("agent_1", "gh:owner/repo:issue:2"),
      resolve("agent_2", "gh:owner/repo:issue:1"),
    ]);
    const base = workspaceNamespace("acct_1", "ws_a");
    expect(one.workspaces[0]?.namespace).toBe(
      `${base}/agent/${normalizeFilesystemNamespace("agent_1")}`,
    );
    expect(oneAgain.workspaces[0]?.namespace).toBe(
      one.workspaces[0]?.namespace,
    );
    expect(two.workspaces[0]?.namespace).not.toBe(one.workspaces[0]?.namespace);
    expect(
      resolveAgentRuntime(agentConfig, { accountId: "acct_1" }),
    ).rejects.toThrow('Workspace isolation "agent" requires an agent identity');
  });

  it("ingests a channel attachment on an agent-isolated workspace as that agent", async () => {
    setStorageForTests({
      sandboxConfigs: { getById: async () => null },
      workspaceConfigs: {
        getById: async () => ({
          config: { storage: { provider: "s3" }, isolation: "agent" },
        }),
      },
    } as never);

    // The download is refused; resolving the workspace before it needs the agent.
    expect(
      ingestChannelAttachments(
        [],
        [
          {
            type: "image",
            name: "photo.png",
            mimeType: "image/png",
            fetchData: async (): Promise<Buffer> => {
              throw new Error("download refused");
            },
          },
        ],
        {
          accountId: "acct_1",
          agentId: "agent_1",
          agentConfig: { workspaces: [{ name: "notes", workspaceId: "ws_a" }] },
          channelName: "slack",
          conversationKey: "slack:C1:T1",
          eventId: "evt_1",
        },
      ),
    ).resolves.toMatchObject({ events: [{ role: "user" }] });
  });

  it("lets a workspace override the agent-level sandbox per agent", async () => {
    setStorageForTests({
      sandboxConfigs: {
        getById: async (_accountId: string, id: string) => {
          if (id === "sb_default")
            return { config: { provider: "lambda", permissionMode: "ask" } };
          if (id === "sb_bypass")
            return { config: { provider: "lambda", permissionMode: "bypass" } };

          return null;
        },
      },
      workspaceConfigs: {
        getById: async (_accountId: string, id: string) =>
          id === "ws_a" ? { config: { storage: { provider: "s3" } } } : null,
      },
    } as never);

    const resolved = await resolveAgentRuntime(
      {
        sandboxes: ["sb_default"],
        workspaces: [
          { name: "notes", workspaceId: "ws_a", sandbox: "sb_bypass" },
        ],
      },
      { accountId: "acct_1" },
    );

    expect(resolved.sandboxes[0]?.sandbox).toMatchObject({
      permissionMode: "ask",
    });
    expect(resolved.workspaces[0]?.sandbox).toMatchObject({
      permissionMode: "bypass",
    });
  });

  it("lets a workspace opt out of the agent-level default with sandbox: null", async () => {
    setStorageForTests({
      sandboxConfigs: {
        getById: async (_accountId: string, id: string) =>
          id === "sb_default"
            ? { config: { provider: "lambda", permissionMode: "ask" } }
            : null,
      },
      workspaceConfigs: {
        getById: async (_accountId: string, id: string) =>
          ({ ws_rw: true, ws_ro: true })[id]
            ? { config: { storage: { provider: "s3" } } }
            : null,
      },
    } as never);

    const resolved = await resolveAgentRuntime(
      {
        sandboxes: ["sb_default"],
        workspaces: [
          { name: "rw", workspaceId: "ws_rw" }, // inherits the default
          { name: "ro", workspaceId: "ws_ro", sandbox: null }, // forced read-only
        ],
      },
      { accountId: "acct_1" },
    );

    expect(resolved.workspaces[0]?.sandbox).toMatchObject({
      permissionMode: "ask",
    });
    expect(resolved.workspaces[1]?.sandbox).toBeUndefined();
    // rw inherits a sandbox (mounts directly); the `sandbox: null` opt-out reads S3
    // directly, so neither carries a read-only mount runner.
    expect(resolved.workspaces[0]?.readMount).toBeUndefined();
    expect(resolved.workspaces[1]?.readMount).toBeUndefined();
  });

  it("refuses a workspace whose effective sandbox cannot reach its storage", async () => {
    setStorageForTests({
      sandboxConfigs: {
        getById: async (_accountId: string, id: string) => ({
          config:
            id === "sb_mac"
              ? { provider: "machine", permissionMode: "edit" }
              : { provider: "lambda", network: { mode: "deny-all" } },
        }),
      },
      workspaceConfigs: {
        getById: async (_accountId: string, id: string) => ({
          config: {
            storage: id === "ws_byo" ? OWN_BUCKET_STORAGE : { provider: "s3" },
          },
        }),
      },
    } as never);

    expect(
      resolveAgentRuntime(
        {
          sandboxes: ["sb_mac"],
          workspaces: [{ name: "notes", workspaceId: "ws_notes" }],
        },
        { accountId: "acct_1" },
      ),
    ).rejects.toThrow('Workspace "notes" cannot run on a machine sandbox');
    // A deny-all MicroVM only routes to the managed bucket.
    const ownBucketRefusal = await resolveAgentRuntime(
      {
        sandboxes: ["sb_vm"],
        workspaces: [{ name: "byo", workspaceId: "ws_byo" }],
      },
      { accountId: "acct_1" },
    ).catch((cause: unknown) => cause);
    expect(String(ownBucketRefusal)).toContain(
      'Workspace "byo" uses its own bucket',
    );
  });

  it("refuses a workspace whose sandbox falls back to cloudflare", async () => {
    setStorageForTests({
      sandboxConfigs: {
        getById: async () => ({
          config: {
            provider: "lambda",
            fallbackProvider: "cloudflare",
            permissionMode: "edit",
          },
        }),
      },
      workspaceConfigs: {
        getById: async () => ({ config: { storage: { provider: "s3" } } }),
      },
    } as never);

    expect(
      resolveAgentRuntime(
        {
          sandboxes: ["sb_box"],
          workspaces: [{ name: "notes", workspaceId: "ws_notes" }],
        },
        { accountId: "acct_1" },
      ),
    ).rejects.toThrow('Workspace "notes" cannot run on a cloudflare sandbox');
  });

  it("resolves a read-only workspace (no agent sandbox, no override) without a sandbox", async () => {
    setStorageForTests({
      sandboxConfigs: { getById: async () => null },
      workspaceConfigs: {
        getById: async (_accountId: string, id: string) =>
          id === "ws_a"
            ? { config: { storage: { provider: "s3" } } }
            : { config: { storage: OWN_BUCKET_STORAGE } },
      },
    } as never);

    const resolved = await resolveAgentRuntime(
      {
        workspaces: [
          { name: "notes", workspaceId: "ws_a" },
          { name: "byo", workspaceId: "ws_b" },
        ],
      },
      { accountId: "acct_1" },
    );

    expect(resolved.sandboxes).toEqual([]);
    expect(resolved.workspaces[0]?.sandbox).toBeUndefined();
    // Implicit read-only defaults to reading through the service-managed read-only mount.
    expect(resolved.workspaces[0]?.readMount).toEqual({
      provider: "lambda",
      network: { mode: "deny-all" },
    });
    // The mount's deny-all network only reaches the managed bucket, so a workspace
    // on its own bucket reads S3 directly with its own role.
    expect(resolved.workspaces[1]?.sandbox).toBeUndefined();
    expect(resolved.workspaces[1]?.readMount).toBeUndefined();
  });

  it("reads a read-only workspace directly from S3 when the ref opts out with sandbox: null", async () => {
    setStorageForTests({
      sandboxConfigs: { getById: async () => null },
      workspaceConfigs: {
        getById: async (_accountId: string, id: string) =>
          id === "ws_a" ? { config: { storage: { provider: "s3" } } } : null,
      },
    } as never);

    const resolved = await resolveAgentRuntime(
      { workspaces: [{ name: "notes", workspaceId: "ws_a", sandbox: null }] },
      { accountId: "acct_1" },
    );

    expect(resolved.workspaces[0]?.sandbox).toBeUndefined();
    // `sandbox: null` => no compute => read straight from S3 (no mount runner).
    expect(resolved.workspaces[0]?.readMount).toBeUndefined();
  });

  it("reserves a persistent agent sandbox on a derived key, and only the agent-level copy", async () => {
    setStorageForTests({
      sandboxConfigs: {
        getById: async (_accountId: string, id: string) => ({
          sandboxId: id,
          name: "reserved",
          config: { provider: "lambda", persistent: true },
        }),
      },
      workspaceConfigs: {
        getById: async () => ({ config: { storage: { provider: "s3" } } }),
      },
    } as never);

    const resolved = await resolveAgentRuntime(
      {
        sandboxes: ["sb_1"],
        workspaces: [{ name: "notes", workspaceId: "ws_a" }],
      },
      { accountId: "acct_1", agentId: "ag_1" },
    );

    expect(resolved.sandboxes[0]?.sandbox.options?.reservationKey).toBe(
      agentSandboxReservationKey("acct_1", "ag_1", "sb_1"),
    );
    // The inherited copy keys persistence on the workspace namespace instead.
    expect(resolved.workspaces[0]?.sandbox?.options).toBeUndefined();
  });

  it("backs an unsandboxed workspace with the first listed sandbox, unreserved", async () => {
    setStorageForTests({
      sandboxConfigs: {
        getById: async (_accountId: string, id: string) => ({
          sandboxId: id,
          name: id,
          config: { provider: "lambda", persistent: true },
        }),
      },
      workspaceConfigs: {
        getById: async () => ({ config: { storage: { provider: "s3" } } }),
      },
    } as never);

    const resolved = await resolveAgentRuntime(
      {
        sandboxes: ["sb_1", "sb_2"],
        workspaces: [{ name: "notes", workspaceId: "ws_a" }],
      },
      { accountId: "acct_1", agentId: "ag_1" },
    );

    expect(resolved.sandboxes[0]?.sandbox.options?.reservationKey).toBe(
      agentSandboxReservationKey("acct_1", "ag_1", "sb_1"),
    );
    // The workspace inherits the first entry, never a later one, and keys its
    // reservation on its own namespace.
    expect(resolved.workspaces[0]?.sandbox?.controlPlane?.sandboxConfigId).toBe(
      "sb_1",
    );
    expect(resolved.workspaces[0]?.sandbox?.options).toBeUndefined();
  });

  it("resolves sandboxes by record name and reserves each on its own key", async () => {
    setStorageForTests({
      sandboxConfigs: {
        getById: async (_accountId: string, id: string) => ({
          sandboxId: id,
          name: id === "sb_browser" ? "browser-sandbox" : "primary",
          ...(id === "sb_browser" ? { description: "Headless Chromium." } : {}),
          config: { provider: "lambda", persistent: id === "sb_browser" },
        }),
      },
      workspaceConfigs: { getById: async () => null },
    } as never);

    const resolved = await resolveAgentRuntime(
      { sandboxes: ["sb_1", "sb_browser"] },
      { accountId: "acct_1", agentId: "ag_1" },
    );

    // The record name is what the model names in bash, and the description is what
    // tells it which sandbox to pick. A non-persistent default reserves nothing, so
    // the extra's key is its own.
    expect(resolved.sandboxes).toEqual([
      {
        name: "primary",
        sandbox: expect.not.objectContaining({ options: expect.anything() }),
      },
      {
        name: "browser-sandbox",
        description: "Headless Chromium.",
        sandbox: expect.objectContaining({
          provider: "lambda",
          persistent: true,
          options: {
            reservationKey: agentSandboxReservationKey(
              "acct_1",
              "ag_1",
              "sb_browser",
            ),
          },
        }),
      },
    ]);
  });

  it("refuses two attached sandboxes that share one record name", async () => {
    setStorageForTests({
      sandboxConfigs: {
        getById: async (_accountId: string, id: string) => ({
          sandboxId: id,
          name: "runner",
          config: { provider: "lambda" },
        }),
      },
      workspaceConfigs: { getById: async () => null },
    } as never);

    expect(
      resolveAgentRuntime(
        { sandboxes: ["sb_1", "sb_2"] },
        { accountId: "acct_1", agentId: "ag_1" },
      ),
    ).rejects.toThrow('Sandbox "runner" is attached twice');
  });

  it("stamps a pinned key in account-scoped form and leaves a non-persistent sandbox alone", async () => {
    setStorageForTests({
      sandboxConfigs: {
        getById: async (_accountId: string, id: string) => ({
          sandboxId: id,
          name: id,
          config:
            id === "sb_pinned"
              ? {
                  provider: "lambda",
                  persistent: true,
                  options: { reservationKey: "team-shared" },
                }
              : { provider: "lambda" },
        }),
      },
      workspaceConfigs: { getById: async () => null },
    } as never);

    const pinned = await resolveAgentRuntime(
      { sandboxes: ["sb_pinned"] },
      { accountId: "acct_1", agentId: "ag_1" },
    );
    // A pinned key deliberately names the machine; derivation must not replace
    // it, but the registry only ever sees it in account-scoped form.
    expect(pinned.sandboxes[0]?.sandbox.options?.reservationKey).toBe(
      pinnedSandboxReservationKey("acct_1", "team-shared"),
    );

    const ephemeral = await resolveAgentRuntime(
      { sandboxes: ["sb_plain"] },
      { accountId: "acct_1", agentId: "ag_1" },
    );
    // Inventing a key without `persistent` would quietly make a throwaway
    // sandbox long-lived.
    expect(ephemeral.sandboxes[0]?.sandbox.options).toBeUndefined();
  });

  it("throws a clear error when a referenced sandbox is missing", async () => {
    setStorageForTests({
      sandboxConfigs: { getById: async () => null },
      workspaceConfigs: { getById: async () => null },
    } as never);

    expect(
      resolveAgentRuntime({ sandboxes: ["missing"] }, { accountId: "acct_1" }),
    ).rejects.toThrow(/Referenced sandbox not found/);
  });
});
