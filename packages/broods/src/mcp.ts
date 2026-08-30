/**
 * MCP server over the account config plane (#58). `broods mcp` serves this on
 * stdio so Claude Code and other development agents drive an account through
 * typed tools instead of hand-rolled curl.
 *
 * Every call goes through {@link BroodsAccountClient}, so auth, base-url
 * resolution and error shapes stay identical to the SDK and the CLI. The
 * credential comes from the environment: prefer a role session
 * (`BROODS_SESSION_TOKEN`) so the policy bounds what this server can reach,
 * and fall back to the account secret only when there is no role.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  BroodsAccountApiError,
  BroodsAccountClient,
  type ToolScope,
  type UpdateAgentInput,
} from "./account.ts";
import type { CreateCronInput } from "./contracts.ts";

/** Arbitrary JSON object arriving over the wire, before a route types it. */
type JsonBody = Record<string, unknown>;

/**
 * One config-plane resource, as the generic tools address it. A resource
 * without a verb rejects it by name, so `broods_get env` explains that env
 * values are write-only rather than 404ing.
 */
interface ResourceOps {
  /** What the id argument names, quoted back in errors. */
  key: string;
  /** Collection routes need a project/stage; tools and MCP servers live in one stage. */
  scoped?: boolean;
  list?: (client: BroodsAccountClient, scope?: ToolScope) => Promise<unknown>;
  get?: (client: BroodsAccountClient, id: string) => Promise<unknown>;
  create?: (
    client: BroodsAccountClient,
    body: JsonBody,
    scope?: ToolScope,
  ) => Promise<unknown>;
  update?: (
    client: BroodsAccountClient,
    id: string,
    body: JsonBody,
  ) => Promise<unknown>;
  remove?: (client: BroodsAccountClient, id: string) => Promise<boolean>;
}

/**
 * The MCP boundary is untyped JSON by protocol, so each route casts the
 * validated object to the SDK's input type at the call. The config plane
 * validates the body again and returns a 400 naming the bad field, which is a
 * better error than anything a mirrored schema here would produce.
 */
const RESOURCES: Record<string, ResourceOps> = {
  agents: {
    key: "agentId",
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
  crons: {
    key: "cronId",
    list: (client) => client.listCrons(),
    get: (client, id) => client.getCron(id),
    create: (client, body) =>
      client.createCron(body as unknown as CreateCronInput),
    update: (client, id, body) => client.updateCron(id, body),
    remove: (client, id) => client.deleteCron(id),
  },
  sandboxes: {
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
  workspaces: {
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
  policies: {
    key: "policyId",
    list: (client) => client.listPolicies(),
    get: (client, id) => client.getPolicy(id),
    create: (client, body) =>
      client.createPolicy(
        body as unknown as Parameters<BroodsAccountClient["createPolicy"]>[0],
      ),
    update: (client, id, body) => client.updatePolicy(id, body),
    remove: (client, id) => client.deletePolicy(id),
  },
  roles: {
    key: "roleId",
    list: (client) => client.listRoles(),
    get: (client, id) => client.getRole(id),
    create: (client, body) =>
      client.createRole(
        body as unknown as Parameters<BroodsAccountClient["createRole"]>[0],
      ),
    update: (client, id, body) => client.updateRole(id, body),
    remove: (client, id) => client.deleteRole(id),
  },
  channels: {
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
  skills: {
    key: "skillName",
    list: (client) => client.listSkills(),
    get: (client, id) => client.getSkill(id),
    create: (client, body) =>
      client.createSkill(
        body as unknown as Parameters<BroodsAccountClient["createSkill"]>[0],
      ),
    update: (client, id, body) =>
      client.uploadSkill(
        id,
        body as unknown as Parameters<BroodsAccountClient["uploadSkill"]>[1],
      ),
    remove: (client, id) => client.deleteSkill(id),
  },
  tools: {
    key: "toolId",
    scoped: true,
    list: (client, scope) => client.listTools(scope!),
    get: (client, id) => client.getTool(id),
    create: (client, body, scope) =>
      client.createTool(
        scope!,
        body as unknown as Parameters<BroodsAccountClient["createTool"]>[1],
      ),
    update: (client, id, body) => client.updateTool(id, body),
    remove: (client, id) => client.deleteTool(id),
  },
  mcp: {
    key: "serverId",
    scoped: true,
    list: (client, scope) => client.listMcpServers(scope!),
    get: (client, id) => client.getMcpServer(id),
    create: (client, body, scope) =>
      client.createMcpServer(
        scope!,
        body as unknown as Parameters<
          BroodsAccountClient["createMcpServer"]
        >[1],
      ),
    update: (client, id, body) => client.updateMcpServer(id, body),
    remove: (client, id) => client.deleteMcpServer(id),
  },
  env: {
    key: "name",
    // Values are write-only: the plane returns names only, so there is no get.
    list: (client) => client.listEnvVars(),
    create: async (client, body) => {
      const name = String(body.name ?? "");
      const value = body.value;
      if (!name || typeof value !== "string")
        throw new Error("env needs a string `name` and a string `value`");
      await client.setEnvVar(name, value);

      return { name: name, stored: true };
    },
    remove: (client, id) => client.deleteEnvVar(id),
  },
};

const RESOURCE_NAMES = Object.keys(RESOURCES) as [string, ...string[]];

function resourceOps(name: string): ResourceOps {
  const ops = RESOURCES[name];
  if (!ops) throw new Error(`Unknown resource '${name}'`);

  return ops;
}

/** Collection routes on a stage-scoped resource need both halves of the scope. */
function requireScope(
  ops: ResourceOps,
  resource: string,
  project: string | undefined,
  stage: string | undefined,
): ToolScope | undefined {
  if (!ops.scoped) return undefined;
  if (!project || !stage)
    throw new Error(
      `${resource} lives in one stage, so this call needs both 'project' and 'stage'`,
    );

  return { project: project, stage: stage };
}

/** MCP wants one text block; JSON keeps the shape the SDK returned. */
function reply(value: unknown): {
  content: [{ type: "text"; text: string }];
} {
  return {
    content: [{ type: "text", text: JSON.stringify(value ?? null, null, 2) }],
  };
}

/** An API error is the agent's to read and act on, not a transport failure. */
function failure(error: unknown): {
  content: [{ type: "text"; text: string }];
  isError: true;
} {
  const text =
    error instanceof BroodsAccountApiError
      ? `${error.message} (${error.status})`
      : error instanceof Error
        ? error.message
        : String(error);

  return { content: [{ type: "text", text: text }], isError: true };
}

async function attempt(
  run: () => Promise<unknown>,
): Promise<ReturnType<typeof reply> | ReturnType<typeof failure>> {
  try {
    return reply(await run());
  } catch (error) {
    return failure(error);
  }
}

/**
 * Build the server. One instance per stdio connection; the client is
 * constructed once and reused, so the credential is read from the environment
 * at startup and never travels through a tool argument.
 */
export function createBroodsMcpServer(
  client: BroodsAccountClient = new BroodsAccountClient({}),
): McpServer {
  const server = new McpServer(
    { name: "broods", version: "1" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "broods_list",
    {
      title: "List broods resources",
      description:
        "List every record of one config-plane resource. 'tools' and 'mcp' live in a single stage, so those two also need 'project' and 'stage'.",
      inputSchema: z.object({
        resource: z.enum(RESOURCE_NAMES),
        project: z.string().optional(),
        stage: z.string().optional(),
      }),
    },
    async ({ resource, project, stage }) =>
      await attempt(async () => {
        const ops = resourceOps(resource);
        if (!ops.list) throw new Error(`Cannot list ${resource}`);

        return await ops.list(
          client,
          requireScope(ops, resource, project, stage),
        );
      }),
  );

  server.registerTool(
    "broods_get",
    {
      title: "Read one broods resource",
      description:
        "Read a single record by id. Env vars have no read: the plane stores values write-only and returns names only.",
      inputSchema: z.object({
        resource: z.enum(RESOURCE_NAMES),
        id: z.string().min(1),
      }),
    },
    async ({ resource, id }) =>
      await attempt(async () => {
        const ops = resourceOps(resource);
        if (!ops.get)
          throw new Error(
            `${resource} has no read route; list it or check the write that created it`,
          );

        return await ops.get(client, id);
      }),
  );

  server.registerTool(
    "broods_create",
    {
      title: "Create a broods resource",
      description:
        "Create one record. 'body' is the request body the config plane documents for that resource, e.g. crons need name, agentId, scheduleExpression and input. Prefer changing the broods/ manifest and deploying for anything the project already declares.",
      inputSchema: z.object({
        resource: z.enum(RESOURCE_NAMES),
        body: z.record(z.string(), z.unknown()),
        project: z.string().optional(),
        stage: z.string().optional(),
      }),
    },
    async ({ resource, body, project, stage }) =>
      await attempt(async () => {
        const ops = resourceOps(resource);
        if (!ops.create) throw new Error(`Cannot create ${resource}`);

        return await ops.create(
          client,
          body,
          requireScope(ops, resource, project, stage),
        );
      }),
  );

  server.registerTool(
    "broods_update",
    {
      title: "Patch a broods resource",
      description:
        "Deep-merge a patch into one record and return the updated resource, so there is no need to read it back. '********' keeps a stored secret and null deletes a field: never send a placeholder you did not read from a get.",
      inputSchema: z.object({
        resource: z.enum(RESOURCE_NAMES),
        id: z.string().min(1),
        body: z.record(z.string(), z.unknown()),
      }),
    },
    async ({ resource, id, body }) =>
      await attempt(async () => {
        const ops = resourceOps(resource);
        if (!ops.update) throw new Error(`Cannot update ${resource}`);

        return await ops.update(client, id, body);
      }),
  );

  server.registerTool(
    "broods_delete",
    {
      title: "Delete a broods resource",
      description:
        "Delete one record. Requires confirm:true, and deletes one id per call: never loop this over a list. Deleting an agent also drops its runtime rows.",
      inputSchema: z.object({
        resource: z.enum(RESOURCE_NAMES),
        id: z.string().min(1),
        confirm: z
          .boolean()
          .describe("Must be true, after the owner has agreed to this delete."),
      }),
    },
    async ({ resource, id, confirm }) =>
      await attempt(async () => {
        const ops = resourceOps(resource);
        if (!ops.remove) throw new Error(`Cannot delete ${resource}`);
        if (!confirm)
          throw new Error(
            `Refusing to delete ${resource} '${id}' without confirm:true. Name what goes away, get the owner's agreement, then retry.`,
          );

        return { deleted: await ops.remove(client, id), id: id };
      }),
  );

  server.registerTool(
    "broods_cron_runs",
    {
      title: "Read a cron's run history",
      description:
        "Run history for one cron, newest first. Check this before telling anyone a cron fired.",
      inputSchema: z.object({
        cronId: z.string().min(1),
        limit: z.number().int().positive().max(100).optional(),
      }),
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

  server.registerTool(
    "broods_sandbox_action",
    {
      title: "Drive a sandbox's lifecycle",
      description:
        "Suspend, resume, terminate or snapshot a persistent sandbox reservation, or mint a short-lived terminal ticket. Snapshot needs a name.",
      inputSchema: z.object({
        sandboxId: z.string().min(1),
        reservationKey: z.string().min(1),
        action: z.enum([
          "suspend",
          "resume",
          "terminate",
          "snapshot",
          "terminal",
        ]),
        name: z.string().optional(),
      }),
    },
    async ({ sandboxId, reservationKey, action, name }) =>
      await attempt(async () => {
        switch (action) {
          case "suspend":
            return await client.suspendSandbox(sandboxId, reservationKey);
          case "resume":
            return await client.resumeSandbox(sandboxId, reservationKey);
          case "terminate":
            return await client.terminateSandbox(sandboxId, reservationKey);
          case "terminal":
            return await client.openSandboxTerminal(sandboxId, reservationKey);
          case "snapshot":
            if (!name) throw new Error("snapshot needs a 'name'");

            return await client.snapshotSandbox(
              sandboxId,
              reservationKey,
              name,
            );
        }
      }),
  );

  server.registerTool(
    "broods_assume_role",
    {
      title: "Mint a scoped session",
      description:
        "Exchange a role for a short-lived session token (default 1h, max 12h). Hand the returned token to whatever tool needs narrow access, as BROODS_SESSION_TOKEN. The token is shown once and is not stored here.",
      inputSchema: z.object({
        roleId: z.string().min(1),
        ttlSeconds: z.number().int().positive().max(43200).optional(),
      }),
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
    "broods_whoami",
    {
      title: "Show the account in reach",
      description:
        "The account this server's credential resolves to. Run it first to confirm which tenant you are about to change.",
      inputSchema: z.object({}),
    },
    async () => await attempt(async () => await client.getAccount()),
  );

  return server;
}
