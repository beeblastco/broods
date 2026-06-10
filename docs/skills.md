# Skills

Skills are account-owned instruction bundles that an agent can load only when a user request needs them. They are useful for domain playbooks, workflow rules, formatting standards, customer support procedures, or tool-specific operating notes that should not live permanently in every system prompt.

Skills are stored by `account-manage` in the S3 skills bucket under `<accountId>/<skill-name>`. Runtime traffic goes through `harness-processing`: `session.ts` lists the configured skill metadata, `tools/index.ts` exposes `load_skill`, and `functions/harness-processing/skills.ts` loads the selected bundle into refreshed system context.

```mermaid
flowchart LR
  Owner["Account owner"] -->|"POST /accounts/me/skills"| Manage["account-manage"]
  Manage -->|"validate bundle"| SkillStore["S3 skills bucket<br/>&lt;accountId&gt;/&lt;skill-name&gt;"]
  Owner -->|"agent config<br/>skills.allowed"| AgentConfig["DynamoDB AgentConfig"]
  AgentConfig --> Session["session.ts"]
  SkillStore -->|"metadata only"| Session
  Session --> Prompt["available skills panel<br/>path + name + description"]
  Prompt --> Model["model"]
  Model -->|"load_skill(path)"| Loader["load-skill.tool.ts"]
  Loader -->|"SKILL.md + resources"| SkillStore
  Loader --> Loaded["loaded skill system context"]
  Loader -->|"stage read/run copy when a workspace is attached"| Workspace["S3 workspace bucket<br/>.claude/skills/&lt;name&gt; (+ .agents/skills mirror)"]
  Workspace --> Sandbox["sandbox runtime"]
```

## Skill Panel

When skills are enabled, the model sees a compact skill panel in system context. The panel lists only configured skill metadata and tells the model to load the detailed instructions before using them:

| Panel field | Source | Purpose |
| --- | --- | --- |
| `path` | `config.skills.allowed[]` | Exact value the model must pass to `load_skill` |
| `name` | `SKILL.md` frontmatter | Human-readable skill identifier |
| `description` | `SKILL.md` frontmatter | Routing hint for when to load the skill |

The detailed `SKILL.md` content is not injected up front. The agent calls `load_skill` with an allowed path, and may request extra resource files from the same bundle only when `SKILL.md` references them. This S3 API path works even when Workspace or Sandbox is disabled: the skill instructions still load. Bundled helper files are executable only when the turn has a sandbox staging path.

When a workspace is attached, `load_skill` stages a fresh read/run copy into the current workspace namespace at `/.claude/skills/<skill-name>` and mirrors the same bundle to `/.agents/skills/<skill-name>` so tools that expect that industry-standard location find it too. Every load re-stages from the account-level skill: stale staged files are dropped and the bundle is re-copied. Files are copied with S3 server-side copy instead of streaming every byte through `harness-processing`.

This makes `.sh`, `.py`, `.js`, `.ts`, and other uploaded text resources available to the sandbox without mounting the skills bucket into the Lambda sandbox. Script files (`.sh`, `.bash`, `.zsh`, `.py`, `.js`, `.mjs`, `.ts`) are staged with executable POSIX metadata so scripts with shebangs can run directly; other text resources are staged as regular, non-executable files. Agents can also invoke scripts explicitly with `bash`, `python3`, or `node`.

## Editing Skill Bundles

Skill editing is handled through the normal workspace feature, not through `load_skill`. If a user wants the agent to modify a skill bundle, attach the skill bundle as a workspace that the agent is allowed to edit. The agent then uses the regular workspace tools (`read`, `write`, `edit`, `glob`, `grep`, and `bash`) against that workspace.

If no workspace containing the skill bundle is attached, the agent can still load the skill instructions with `load_skill`, but it cannot modify the account-owned skill bundle. Runtime staging is separate from editing: when a sandbox staging path is available, `load_skill` copies helper files into that path for read/run use; when no sandbox staging path is available, the instructions still load but bundled scripts cannot be executed in that turn.

```mermaid
flowchart LR
  User["User asks to edit a skill"] --> Workspace{"Skill bundle attached<br/>as editable workspace?"}
  Workspace -->|"yes"| Tools["Use normal workspace tools"]
  Tools --> SkillFiles["Modify SKILL.md and resources"]
  Workspace -->|"no"| LoadOnly["load_skill cannot edit the source bundle"]
```

Workspace-backed skill edits have the same S3 Files consistency caveat as other sandbox writes. Files written through the sandbox mount are visible immediately inside that sandbox, but harness-side S3 API reads, S3 listing, or another sandbox may not see the changes for about 1-2 minutes. See [Workspace storage](workspace/storage.md#reading-workspace-files-s3-api-vs-the-sandbox-mount) for the read/write path details.

## Create Skills

BeeBlast skill bundles follow the open [Agent Skills format](https://agentskills.io/home): a skill is a folder with a required `SKILL.md` file, metadata for discovery, and optional supporting resources. For authoring guidance, start with the external [Agent Skills quickstart](https://agentskills.io/skill-creation/quickstart) and check the [Agent Skills specification](https://agentskills.io/specification) before uploading a bundle.

### Bundle Shape

Every skill bundle must include a root `SKILL.md` file with YAML frontmatter:

```md
---
name: support-flow
description: Handles support triage and escalation decisions.
---

# Support Flow

Use this skill when a customer asks for help with a product issue.

## Steps

1. Classify urgency.
2. Identify the product area.
3. Recommend the next action.
```

Skill names must be lowercase letters, numbers, and hyphens only (max 64 characters; names containing `anthropic`/`claude` or XML tags are rejected). The stored path is generated from the `SKILL.md` name as `<accountId>/<skill-name>`, not from the local folder name used during upload.

Bundle limits:

- Each file can be up to 5 MB.
- The full bundle can be up to 30 MB.
- Files must be supported text files: `.css`, `.csv`, `.html`, `.js`, `.json`, `.md`, `.mjs`, `.py`, `.sh`, `.sql`, `.svg`, `.toml`, `.ts`, `.tsx`, `.txt`, `.xml`, `.yaml`, or `.yml`.
- Uploaded file paths must be relative to the skill root. Use `SKILL.md`, not `support-flow/SKILL.md`.

Bundles can also include supporting text files. When the model needs one, it calls:

```json
{
  "path": "acct_abc123/support-flow",
  "resources": ["examples/escalation-policy.md"]
}
```

For executable helpers, keep scripts inside the bundle and reference them from `SKILL.md`, for example `scripts/analyze.py` or `scripts/run.sh`. After `load_skill`, those files are staged under `/.claude/skills/<skill-name>/scripts/` (and mirrored under `/.agents/skills/<skill-name>/scripts/`) inside the current sandbox. The staged files are normal files in that run path, so the agent can read and run them.

Enable skills for an agent with `config.skills`:

```json
{
  "skills": {
    "enabled": true,
    "allowed": ["acct_abc123/support-flow"]
  }
}
```

The account API accepts three sources:

| Source | Use when | Required fields |
| --- | --- | --- |
| `json` | Creating a single-file skill from API input | `name`, `description`, `content` |
| `files` | Uploading a bundle with `SKILL.md` and support files | `files[].path`, `files[].contentBase64` |
| `github` | Importing a skill directory from GitHub | `url` |

Single-file example:

```http
POST /accounts/me/skills
Authorization: Bearer <account-secret>
Content-Type: application/json
```

```json
{
  "source": "json",
  "name": "support-flow",
  "description": "Handles support triage and escalation decisions.",
  "content": "# Support Flow\n\nUse this skill when a customer asks for help with a product issue."
}
```

:::warning GitHub imports

GitHub imports download a skill directory from a public GitHub tree URL. Use this only for repositories and refs you trust, and pin the URL to the intended branch, tag, or commit path:

`https://github.com/{owner}/{repo}/tree/{ref}/{path}`

:::

See [`examples/skills.ts`](../examples/skills.ts) for create, list, get, and delete calls.

## Enable Skills For An Agent

Creating a skill only stores the bundle. Add the generated skill paths to the agent config before the runtime exposes them:

```json
{
  "skills": {
    "enabled": true,
    "allowed": [
      "acct_abc123/support-flow",
      "acct_abc123/knowledge-base"
    ]
  }
}
```

Runtime behavior:

1. `config.skills.enabled` must be `true`.
2. `config.skills.allowed` must contain at least one account-owned skill path.
3. Agent create/update validates that each allowed path belongs to the same account and exists.
4. `load_skill` is registered only for skill-enabled agents with a request session.
5. The loader rejects paths that are not in `config.skills.allowed`.

Use [`examples/skill-loads.ts`](../examples/skill-loads.ts) for an end-to-end streaming request that creates a temporary skill, attaches it to an agent, and asks the agent to load it.

## Design Rules

- Keep skill CRUD in `functions/account-manage/skills.ts`.
- Keep shared validation and S3 path rules in `functions/_shared/skills.ts`.
- Keep runtime prompt loading in `functions/harness-processing/skills.ts`.
- Keep the model-facing `load_skill` schema in `functions/harness-processing/tools/load-skill.tool.ts`.
- Do not put tool credentials or channel secrets inside skill bundles.
- Use skill descriptions as routing hints; keep detailed instructions inside `SKILL.md`.
- Prefer resource files for large examples or reference tables so the model can load them only when needed.
