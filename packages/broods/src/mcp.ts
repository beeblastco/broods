/**
 * MCP server over the account config plane (#58). `broods mcp` serves this on
 * stdio so Claude Code and other development agents drive an account through
 * typed tools instead of hand-rolled curl.
 *
 * Tool names mirror {@link BroodsAccountClient}'s methods in kebab-case, so
 * `listAgents` is `list-agents` and an agent that knows the SDK already knows
 * this surface. Every call goes through the client, so auth, base-url
 * resolution and error shapes stay identical to the SDK and the CLI. The
 * credential comes from the environment: prefer a role session
 * (`BROODS_SESSION_TOKEN`) so the policy bounds what this server can reach,
 * and fall back to the account secret only when there is no role.
 */

import { type CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  BroodsAccountClient,
  type CreateMcpInput,
  type SkillUploadInput,
  type StageScope,
  type UpdateAgentInput,
} from "./account.ts";
import type { CreateCronInput } from "./contracts.ts";
import type { BroodsSyncClient } from "./sync.ts";

/** Arbitrary JSON object arriving over the wire, before a route types it. */
type JsonBody = Record<string, unknown>;

/** Default project/stage for scoped calls; explicit arguments win. */
export interface McpScopeDefaults {
  project?: string;
  stage?: string;
}

export interface BroodsMcpServerOptions {
  /** Login-scoped client; registers the org/project/stage tools when set. */
  cli?: BroodsSyncClient | null;
  /** Scope defaults from the runtime config (BROODS_PROJECT / BROODS_STAGE). */
  scope?: McpScopeDefaults;
}

const SCOPE_FIELDS = {
  project: z.string().optional(),
  stage: z.string().optional(),
};

const LIFECYCLE_FIELDS = {
  sandboxId: z.string().min(1),
  reservationKey: z.string().min(1),
};

const CONFIRM_FIELD = z
  .boolean()
  .describe("Must be true, after the owner has agreed to this delete.");

/**
 * One config-plane resource. The names drive the tool names, so `agent` plus
 * `agents` registers get/create/update/delete-agent and list-agents. A verb
 * left out is a verb the plane does not serve, and no tool is registered for
 * it: skills have no plain update, they have `upload-skill`.
 */
interface ResourceSpec {
  singular: string;
  plural: string;
  /** What the id argument names, quoted in its description. */
  key: string;
  /** Collection routes need a project/stage; MCP servers live in one stage. */
  scoped?: boolean;
  /** Appended to the create tool's description, naming the fields that trip people up. */
  createHint?: string;
  /** Appended to the delete tool's description, naming what else goes away. */
  deleteHint?: string;
  list?: (client: BroodsAccountClient, scope?: StageScope) => Promise<unknown>;
  get?: (client: BroodsAccountClient, id: string) => Promise<unknown>;
  create?: (
    client: BroodsAccountClient,
    body: JsonBody,
    scope?: StageScope,
  ) => Promise<unknown>;
  update?: (
    client: BroodsAccountClient,
    id: string,
    body: JsonBody,
  ) => Promise<unknown>;
  remove?: (client: BroodsAccountClient, id: string) => Promise<boolean>;
}

/** Wire bodies are untyped JSON; the config plane re-validates each one. */
const RESOURCES: ResourceSpec[] = [
  {
    singular: "agent",
    plural: "agents",
    key: "agentId",
    createHint: "Needs name and config; a 409 returns the existing agentId.",
    deleteHint: "Deleting an agent also drops its runtime rows.",
    list: (client) => client.listAgents(),
    get: (client, id) => client.getAgent(id),
    create: (client, body) =>
      client.createAgent(
        body as unknown as Parameters<BroodsAccountClient["createAgent"]>[0],
      ),
    update: (client, id, body) =>
      client.updateAgent(id, body as unknown as UpdateAgentInput),
    remove: (client, id) => client.deleteAgent(id),
  },
  {
    singular: "cron",
    plural: "crons",
    key: "cronId",
    createHint:
      "Needs name, agentId, scheduleExpression (rate/cron/at) and input or events.",
    list: (client) => client.listCrons(),
    get: (client, id) => client.getCron(id),
    create: (client, body) =>
      client.createCron(body as unknown as CreateCronInput),
    update: (client, id, body) => client.updateCron(id, body),
    remove: (client, id) => client.deleteCron(id),
  },
  {
    singular: "sandbox",
    plural: "sandboxes",
    key: "sandboxId",
    list: (client) => client.listSandboxes(),
    get: (client, id) => client.getSandbox(id),
    create: (client, body) =>
      client.createSandbox(
        body as unknown as Parameters<BroodsAccountClient["createSandbox"]>[0],
      ),
    update: (client, id, body) => client.updateSandbox(id, body),
    remove: (client, id) => client.deleteSandbox(id),
  },
  {
    singular: "workspace",
    plural: "workspaces",
    key: "workspaceId",
    list: (client) => client.listWorkspaces(),
    get: (client, id) => client.getWorkspace(id),
    create: (client, body) =>
      client.createWorkspace(
        body as unknown as Parameters<
          BroodsAccountClient["createWorkspace"]
        >[0],
      ),
    update: (client, id, body) => client.updateWorkspace(id, body),
    remove: (client, id) => client.deleteWorkspace(id),
  },
  {
    singular: "policy",
    plural: "policies",
    key: "policyId",
    createHint:
      "Agent-runtime policy document (tool.call, skill.load), not API credential scoping.",
    list: (client) => client.listPolicies(),
    get: (client, id) => client.getPolicy(id),
    create: (client, body) =>
      client.createPolicy(
        body as unknown as Parameters<BroodsAccountClient["createPolicy"]>[0],
      ),
    update: (client, id, body) => client.updatePolicy(id, body),
    remove: (client, id) => client.deletePolicy(id),
  },
  {
    singular: "role",
    plural: "roles",
    key: "roleId",
    createHint:
      "Needs name and a version-1 policy over the API namespace, e.g. agents:read. Account secret only.",
    list: (client) => client.listRoles(),
    get: (client, id) => client.getRole(id),
    create: (client, body) =>
      client.createRole(
        body as unknown as Parameters<BroodsAccountClient["createRole"]>[0],
      ),
    update: (client, id, body) => client.updateRole(id, body),
    remove: (client, id) => client.deleteRole(id),
  },
  {
    singular: "channel",
    plural: "channels",
    key: "channelId",
    list: (client) => client.listChannels(),
    get: (client, id) => client.getChannel(id),
    create: (client, body) =>
      client.createChannel(
        body as unknown as Parameters<BroodsAccountClient["createChannel"]>[0],
      ),
    update: (client, id, body) => client.updateChannel(id, body),
    remove: (client, id) => client.deleteChannel(id),
  },
  {
    singular: "skill",
    plural: "skills",
    key: "skillName",
    createHint:
      'source is "files" (base64), "json" or "github". The stored name comes from the SKILL.md frontmatter.',
    list: (client) => client.listSkills(),
    get: (client, id) => client.getSkill(id),
    create: (client, body) =>
      client.createSkill(body as unknown as SkillUploadInput),
    remove: (client, id) => client.deleteSkill(id),
  },
  {
    singular: "mcp",
    plural: "mcp",
    key: "serverId",
    scoped: true,
    list: (client, scope) => client.listMcp(scope as StageScope),
    get: (client, id) => client.getMcp(id),
    create: (client, body, scope) =>
      client.createMcp(scope as StageScope, body as unknown as CreateMcpInput),
    update: (client, id, body) => client.updateMcp(id, body),
    remove: (client, id) => client.deleteMcp(id),
  },
];

/**
 * Build the server. One instance per stdio connection; the client is
 * constructed once and reused, so the credential is read from the environment
 * at startup and never travels through a tool argument.
 */
export function createBroodsMcpServer(
  options: BroodsMcpServerOptions = {},
): McpServer {
  const client = new BroodsAccountClient({});
  const server = new McpServer(
    { name: "broods", version: "1" },
    { capabilities: { tools: {} } },
  );

  for (const spec of RESOURCES) {
    registerResource(server, client, spec, options.scope ?? {});
  }
  registerExtras(server, client);
  if (options.cli) registerCliScope(server, options.cli);

  return server;
}

/** MCP wants one text block; JSON keeps the shape the SDK returned. */
function reply(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value ?? null, null, 2) }],
  };
}

/** An API error is the agent's to read and act on, not a transport failure. */
function failure(error: unknown): CallToolResult {
  const text = error instanceof Error ? error.message : String(error);

  return { content: [{ type: "text", text: text }], isError: true };
}

/** The one gate every destructive tool passes; `consequence` names the blast radius. */
function assertConfirmed(
  confirm: boolean | undefined,
  consequence: string,
): void {
  if (!confirm) {
    throw new Error(`Refusing without confirm:true. ${consequence}`);
  }
}

async function attempt(run: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return reply(await run());
  } catch (error) {
    return failure(error);
  }
}

/**
 * Collection routes on a stage-scoped resource need both halves of the scope;
 * arguments win over the defaults the runtime config supplied at startup.
 */
function requireScope(
  spec: ResourceSpec,
  defaults: McpScopeDefaults,
  project: string | undefined,
  stage: string | undefined,
): StageScope | undefined {
  if (!spec.scoped) return undefined;
  const resolvedProject = project ?? defaults.project;
  const resolvedStage = stage ?? defaults.stage;
  if (!resolvedProject || !resolvedStage)
    throw new Error(
      `${spec.plural} live in one stage, so this call needs both 'project' and 'stage'`,
    );

  return { project: resolvedProject, stage: resolvedStage };
}

/** Register list/get/create/update/delete for one resource, skipping absent verbs. */
function registerResource(
  server: McpServer,
  client: BroodsAccountClient,
  spec: ResourceSpec,
  defaults: McpScopeDefaults,
): void {
  const idField = z.string().min(1).describe(`The ${spec.key}.`);
  const scopeNote = spec.scoped
    ? ` ${spec.plural} live in one stage, so this also takes 'project' and 'stage'.`
    : "";
  const { list, get, create, update, remove } = spec;

  // Scoped and unscoped register separately so each handler's arguments stay
  // typed; a conditional shape widens them to unknown.
  if (list) {
    const description = `List every ${spec.singular} on the account.${scopeNote}`;
    if (spec.scoped) {
      server.registerTool(
        `list-${spec.plural}`,
        { description: description, inputSchema: SCOPE_FIELDS },
        async ({ project, stage }) =>
          await attempt(
            async () =>
              await list(client, requireScope(spec, defaults, project, stage)),
          ),
      );
    } else {
      server.registerTool(
        `list-${spec.plural}`,
        { description: description, inputSchema: {} },
        async () => await attempt(async () => await list(client)),
      );
    }
  }

  if (get) {
    server.registerTool(
      `get-${spec.singular}`,
      {
        description: `Read one ${spec.singular} by ${spec.key}.`,
        inputSchema: { id: idField },
      },
      async ({ id }) => await attempt(async () => await get(client, id)),
    );
  }

  if (create) {
    const description =
      `Create one ${spec.singular}. 'body' is the request body the config plane documents.` +
      (spec.createHint ? ` ${spec.createHint}` : "") +
      scopeNote +
      " Prefer changing the broods/ manifest and deploying for anything the project already declares.";
    const body = z.record(z.string(), z.unknown());
    if (spec.scoped) {
      server.registerTool(
        `create-${spec.singular}`,
        {
          description: description,
          inputSchema: { body: body, ...SCOPE_FIELDS },
        },
        async ({ body, project, stage }) =>
          await attempt(
            async () =>
              await create(
                client,
                body,
                requireScope(spec, defaults, project, stage),
              ),
          ),
      );
    } else {
      server.registerTool(
        `create-${spec.singular}`,
        { description: description, inputSchema: { body: body } },
        async ({ body }) =>
          await attempt(async () => await create(client, body)),
      );
    }
  }

  if (update) {
    server.registerTool(
      `update-${spec.singular}`,
      {
        description:
          `Deep-merge a patch into one ${spec.singular} and return the updated record, so there is no need to read it back. ` +
          "'********' keeps a stored secret and null deletes a field: never send a placeholder you did not read from a get.",
        inputSchema: {
          id: idField,
          body: z.record(z.string(), z.unknown()),
        },
      },
      async ({ id, body }) =>
        await attempt(async () => await update(client, id, body)),
    );
  }

  if (remove) {
    server.registerTool(
      `delete-${spec.singular}`,
      {
        description:
          `Delete one ${spec.singular}. Requires confirm:true, and takes one ${spec.key} per call: never loop this over a list.` +
          (spec.deleteHint ? ` ${spec.deleteHint}` : ""),
        inputSchema: {
          id: idField,
          confirm: CONFIRM_FIELD,
        },
      },
      async ({ id, confirm }) =>
        await attempt(async () => {
          assertConfirmed(
            confirm,
            `Deleting ${spec.singular} '${id}' goes away for good: name it, get the owner's agreement, then retry.`,
          );

          return { deleted: await remove(client, id), id: id };
        }),
    );
  }
}

/** The calls that do not fit the five-verb shape. */
function registerExtras(server: McpServer, client: BroodsAccountClient): void {
  server.registerTool(
    "list-cron-runs",
    {
      description:
        "Run history for one cron, newest first. Check this before telling anyone a cron fired.",
      inputSchema: {
        cronId: z.string().min(1),
        limit: z.number().int().positive().max(100).optional(),
      },
    },
    async ({ cronId, limit }) =>
      await attempt(
        async () =>
          await client.listCronRuns(
            cronId,
            limit === undefined ? {} : { limit: limit },
          ),
      ),
  );

  const lifecycleTools: Array<
    [
      string,
      string,
      (sandboxId: string, reservationKey: string) => Promise<unknown>,
    ]
  > = [
    [
      "suspend-sandbox",
      "Suspend a persistent sandbox reservation.",
      (sandboxId, reservationKey) =>
        client.suspendSandbox(sandboxId, reservationKey),
    ],
    [
      "resume-sandbox",
      "Resume a suspended sandbox reservation.",
      (sandboxId, reservationKey) =>
        client.resumeSandbox(sandboxId, reservationKey),
    ],
    [
      "terminate-sandbox",
      "Terminate a sandbox reservation and drop its live-instance row. Terminate only a sandbox you created, and never one holding state you did not put there.",
      (sandboxId, reservationKey) =>
        client.terminateSandbox(sandboxId, reservationKey),
    ],
    [
      "open-sandbox-terminal",
      "Mint a short-lived sealed ticket for an interactive PTY session on a persistent sandbox.",
      (sandboxId, reservationKey) =>
        client.openSandboxTerminal(sandboxId, reservationKey),
    ],
  ];
  for (const [name, description, call] of lifecycleTools) {
    server.registerTool(
      name,
      { description: description, inputSchema: LIFECYCLE_FIELDS },
      async ({ sandboxId, reservationKey }) =>
        await attempt(async () => await call(sandboxId, reservationKey)),
    );
  }

  server.registerTool(
    "snapshot-sandbox",
    {
      description:
        "Snapshot a sandbox reservation into a reusable image (self-hosted provider).",
      inputSchema: {
        sandboxId: z.string().min(1),
        reservationKey: z.string().min(1),
        name: z.string().min(1),
      },
    },
    async ({ sandboxId, reservationKey, name }) =>
      await attempt(
        async () =>
          await client.snapshotSandbox(sandboxId, reservationKey, name),
      ),
  );

  server.registerTool(
    "upload-skill",
    {
      description:
        "Replace one skill's bundle wholesale (PUT, not a merge) by skillName. 'body' is the same source shape create-skill takes.",
      inputSchema: {
        id: z.string().min(1).describe("The skillName."),
        body: z.record(z.string(), z.unknown()),
      },
    },
    async ({ id, body }) =>
      await attempt(
        async () =>
          await client.uploadSkill(id, body as unknown as SkillUploadInput),
      ),
  );

  server.registerTool(
    "list-env-vars",
    {
      description:
        "List environment variable names. Values are write-only: the plane never returns them, so there is no read.",
      inputSchema: {},
    },
    async () => await attempt(async () => await client.listEnvVars()),
  );

  server.registerTool(
    "set-env-var",
    {
      description:
        "Create or replace one write-only environment variable. Reference it from a config as ${NAME} rather than inlining the value.",
      inputSchema: {
        name: z.string().min(1),
        value: z.string(),
      },
    },
    async ({ name, value }) =>
      await attempt(async () => {
        await client.setEnvVar(name, value);

        return { name: name, stored: true };
      }),
  );

  server.registerTool(
    "delete-env-var",
    {
      description: "Delete one environment variable.",
      inputSchema: {
        name: z.string().min(1),
        confirm: CONFIRM_FIELD,
      },
    },
    async ({ name, confirm }) =>
      await attempt(async () => {
        assertConfirmed(
          confirm,
          `Anything referencing \${${name}} breaks the moment this env var goes.`,
        );

        return { deleted: await client.deleteEnvVar(name), name: name };
      }),
  );

  server.registerTool(
    "assume-role",
    {
      description:
        "Exchange a role for a short-lived session token (default 1h, max 12h). Hand the returned token to whatever tool needs narrow access, as BROODS_SESSION_TOKEN. It is shown once and is not stored here.",
      inputSchema: {
        roleId: z.string().min(1),
        ttlSeconds: z.number().int().positive().max(43200).optional(),
      },
    },
    async ({ roleId, ttlSeconds }) =>
      await attempt(
        async () =>
          await client.assumeRole(
            roleId,
            ttlSeconds === undefined ? {} : { ttlSeconds: ttlSeconds },
          ),
      ),
  );

  server.registerTool(
    "update-account",
    {
      description:
        "Rename this account or change its description. Everything else about an account is derived, not settable.",
      inputSchema: {
        username: z.string().optional(),
        description: z.string().nullable().optional(),
      },
    },
    async ({ username, description }) =>
      await attempt(
        async () =>
          await client.updateAccount({
            ...(username === undefined ? {} : { username: username }),
            ...(description === undefined ? {} : { description: description }),
          }),
      ),
  );

  server.registerTool(
    "rotate-secret",
    {
      description:
        "Rotate the account secret. The current secret stops working immediately and the new one is shown once, so this breaks every deployment and CI job still holding the old one. Requires confirm:true.",
      inputSchema: { confirm: CONFIRM_FIELD },
    },
    async ({ confirm }) =>
      await attempt(async () => {
        assertConfirmed(
          confirm,
          "Everything holding the current secret breaks the moment this runs.",
        );

        return await client.rotateSecret();
      }),
  );

  server.registerTool(
    "get-account",
    {
      description:
        "The account this server's credential resolves to. Run it first to confirm which tenant you are about to change.",
      inputSchema: {},
    },
    async () => await attempt(async () => await client.getAccount()),
  );
}

/**
 * Org, project and stage live behind the CLI router, not the config plane, so
 * they need a login token rather than an account secret or a role session.
 * They are registered only when `broods login` has stored one: a role session
 * is rejected by that router, so offering the tools without a login would hand
 * the agent four calls that can only 401.
 */
function registerCliScope(server: McpServer, cli: BroodsSyncClient): void {
  server.registerTool(
    "list-orgs",
    {
      description:
        "Every organization this login can reach, with the current one marked.",
      inputSchema: {},
    },
    async () =>
      await attempt(async () => {
        const context = await cli.getOnboarding();

        return { currentOrgId: context.currentOrgId, orgs: context.orgs };
      }),
  );

  server.registerTool(
    "create-org",
    {
      description:
        "Create an organization and switch this login to it. Later calls act in the new org.",
      inputSchema: { name: z.string().min(1) },
    },
    async ({ name }) =>
      await attempt(async () => await cli.createOnboardingOrg(name)),
  );

  server.registerTool(
    "select-org",
    {
      description:
        "Switch this login to another organization, by an orgId from list-orgs.",
      inputSchema: { orgId: z.string().min(1) },
    },
    async ({ orgId }) =>
      await attempt(async () => await cli.selectOnboardingOrg(orgId)),
  );

  server.registerTool(
    "list-projects",
    {
      description:
        "Every project in the current org, empty ones last. Project names are not unique, so take the id from here.",
      inputSchema: {},
    },
    async () => await attempt(async () => await cli.listProjects()),
  );

  server.registerTool(
    "delete-project",
    {
      description:
        "Delete a project and everything under it: stages, agents, canvas, env vars, crons and workspace files. Takes a projectId from list-projects and requires confirm:true.",
      inputSchema: { projectId: z.string().min(1), confirm: CONFIRM_FIELD },
    },
    async ({ projectId, confirm }) =>
      await attempt(async () => {
        assertConfirmed(
          confirm,
          `Project '${projectId}' and everything under it goes away: name it, get the owner's agreement, then retry.`,
        );

        return await cli.deleteProject(projectId);
      }),
  );

  server.registerTool(
    "list-stages",
    {
      description: "Every stage of one project, by project name.",
      inputSchema: { project: z.string().min(1) },
    },
    async ({ project }) =>
      await attempt(async () => await cli.listStages(project)),
  );

  server.registerTool(
    "create-stage",
    {
      description:
        "Create a stage in a project, optionally cloning another stage's architecture and env vars. A project name that does not exist yet is created with it, which is the only way to make a project without deploying a manifest.",
      inputSchema: {
        project: z.string().min(1),
        name: z.string().min(1),
        from: z
          .string()
          .optional()
          .describe("Stage to clone architecture and env vars from."),
      },
    },
    async ({ project, name, from }) =>
      await attempt(async () => await cli.createStage(project, name, from)),
  );
}
