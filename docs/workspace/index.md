# Workspace & Sandbox

**Sandbox** (compute) and **workspace** (persistent files) are account-scoped resources. You define each once and reference it from any agent by id.

- A **sandbox** is the compute backend plus a collection of bash and filesystem tools
  (`bash`, `read`, `write`, `edit`, `glob`, `grep`) and a `permissionMode`.
- A **workspace** is the persistent S3-backed filesystem that gets mounted into a sandbox.
  Agents that reference the **same** `workspaceId` read and write the **same files**.

A sandbox can be attached **agent-wide** (`config.sandbox`) or **per workspace**
(`workspaces[].sandbox`). A workspace's **effective sandbox** follows a simple cascade:

```text
workspaces[].sandbox === null   → read-only (opt out, even if a default exists)
workspaces[].sandbox === "sb_…" → that sandbox (override)
workspaces[].sandbox omitted    → inherit config.sandbox (read-only if there is none)
```

This is what lets one agent give different workspaces different sandboxes and
`permissionMode`s, lets two agents that share a workspace access it through their own
sandboxes, and lets a single workspace be **read-only** — served directly from the S3 API
(no mount, no Lambda cold start). `config.sandbox` also powers stateless `bash` when there
is no workspace at all.

```mermaid
flowchart LR
  subgraph Account
    SB["sandboxConfig (sb_…)<br/>provider · permissionMode · internet"]
    WS["workspaceConfig (ws_…)<br/>storage · harness"]
  end
  subgraph AgentA["Agent A config"]
    A["sandbox: sb_…<br/>workspaces: [notes → ws_…]"]
  end
  subgraph AgentB["Agent B config"]
    B["workspaces: [notes → ws_…, sandbox: sb_…]<br/>(per-workspace override)"]
  end
  A --> SB
  A --> WS
  B --> SB
  B --> WS
  WS -. shared files .- A
  WS -. shared files .- B
```

## Config

Create the records via the account API, then reference them from the agent:

```jsonc
// POST /accounts/me/sandboxes
{ "name": "default", "config": { "provider": "lambda", "internet": true, "permissionMode": "ask" } }

// POST /accounts/me/workspaces
{ "name": "notes", "config": { "storage": { "provider": "s3" }, "harness": { "enabled": true } } }

// agent config
{
  "sandbox": "sb_xxx",                                 // optional agent-level sandbox id
  "workspaces": [                                      // optional; name = mount label
    { "name": "notes", "workspaceId": "ws_aaa" },                     // inherits the agent-level sandbox
    { "name": "team",  "workspaceId": "ws_bbb", "sandbox": "sb_yyy" }, // per-workspace override
    { "name": "docs",  "workspaceId": "ws_ccc", "sandbox": null }      // forced read-only (S3 direct)
  ]
}
```

## Tool surface

Tool availability is decided **per workspace**, from that workspace's *effective* sandbox
(`workspaces[].sandbox` → else `config.sandbox` → else none). The agent's tool set is the
union across its workspaces:

| Workspace's effective sandbox | Tools for that workspace |
| --- | --- |
| present (mounted) | `read`, `write`, `edit`, `glob`, `grep`, `bash` (+ MEMORY/TASKS harness) |
| **none** (read-only) | `read`, `glob` — served straight from S3 (no mount, no cold start) |

Plus the agent-level cases:

| Agent references | Tools exposed |
| --- | --- |
| sandbox, **no** workspace | `bash` only — **stateless** (each call is a fresh container; nothing persists) |
| neither sandbox nor workspace | none |

> When workspaces have different sandboxes, the model picks one with the `workspace`
> argument; each call routes to that workspace's sandbox and inherits its `permissionMode`.
> `write`/`edit`/`grep`/`bash` only list the sandbox-backed workspaces; `read`/`glob` list
> all of them.

## permissionMode

`permissionMode` lives on the sandbox and replaces the old `needsApproval` boolean:

| Mode | `read`/`glob`/`grep` | `write`/`edit` | `bash` |
| --- | --- | --- | --- |
| `ask` | auto | **ask** | **ask** |
| `edit` | auto | auto | **ask** |
| `bypass` | auto | auto | auto |

## Runtime model

```mermaid
flowchart TD
  Request["Direct API / Async / Channel webhook"] --> Handler["handler.ts"]
  Handler --> Session["session.ts<br/>resolveAgentRuntime()"]
  Session --> Resolve["sandbox + workspace records<br/>(account-scoped lookups)"]
  Session --> Harness["harness.ts (streamText loop)"]
  Harness --> Tools["tools/index.ts<br/>per-workspace sandbox + permissionMode"]
  Tools --> Sandbox["sandbox executor (run)<br/>lambda / e2b / daytona / kubernetes"]
  Tools -. read/glob on read-only workspace .-> Files
  Sandbox --> Files["workspace files on S3<br/>namespace = hash(accountId:workspaceId)"]
  Session -. MEMORY.md via S3 API .-> Files
```

The workspace **namespace** is derived from `accountId:workspaceId` (not the
conversation), which is what makes a workspace shared across agents and conversations.
Set `workspace.harness.enabled: false` to suppress the MEMORY/TASKS guidance while still
loading an existing `MEMORY.md`.
