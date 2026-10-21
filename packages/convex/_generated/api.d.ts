/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";
import type { GenericId as Id } from "convex/values";

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: {
  access: {
    addRule: FunctionReference<
      "mutation",
      "public",
      {
        condition?: {
          attribute: string;
          operator:
            "equals" | "notEquals" | "in" | "notIn" | "prefix" | "contains";
          value: string;
        };
        effect?: "allow" | "deny";
        permission: string;
        policyId: Id<"agentPolicies">;
        scope: { projectId?: Id<"projects">; stageId?: Id<"stages"> };
      },
      string
    >;
    createPermission: FunctionReference<
      "mutation",
      "public",
      { description?: string; name: string; resource: string },
      Id<"permissions">
    >;
    createPolicy: FunctionReference<
      "mutation",
      "public",
      { description?: string; mode: "audit" | "enforce"; name: string },
      Id<"agentPolicies">
    >;
    createRole: FunctionReference<
      "mutation",
      "public",
      {
        description?: string;
        name: string;
        policyIds: Array<Id<"agentPolicies">>;
      },
      Id<"orgRoles">
    >;
    listPermissions: FunctionReference<
      "query",
      "public",
      {},
      Array<
        | {
            description: string;
            kind: "built-in";
            name: string;
            resource: string;
          }
        | {
            _id: Id<"permissions">;
            createdAt: number;
            createdBy?: { avatarUrl?: string; name: string };
            description: string;
            kind: "custom";
            name: string;
            resource: string;
          }
      >
    >;
    listPolicies: FunctionReference<
      "query",
      "public",
      {},
      Array<{
        _id: Id<"agentPolicies">;
        createdAt: number;
        createdBy?: { avatarUrl?: string; name: string };
        description?: string;
        managedBy?: string;
        mode: "audit" | "enforce";
        name: string;
        permissions: Array<string>;
        rules: Array<{
          condition?: string;
          effect: "allow" | "deny";
          id: string;
          permissions: Array<string>;
          scope: string;
        }>;
        scope: string;
      }>
    >;
    listRoles: FunctionReference<
      "query",
      "public",
      {},
      Array<
        | {
            description: string;
            kind: "built-in";
            members: Array<{ avatarUrl?: string; name: string }>;
            name: string;
            permissions: Array<
              "keys:read" | "keys:write" | "members:write" | "access:write"
            >;
            policyIds: Array<Id<"agentPolicies">>;
            tier: "owner" | "admin" | "member";
          }
        | {
            _id: Id<"orgRoles">;
            createdAt: number;
            createdBy?: { avatarUrl?: string; name: string };
            description: string;
            kind: "custom";
            members: Array<{ avatarUrl?: string; name: string }>;
            name: string;
            permissions: Array<
              "keys:read" | "keys:write" | "members:write" | "access:write"
            >;
            policyIds: Array<Id<"agentPolicies">>;
          }
      >
    >;
    removePermission: FunctionReference<
      "mutation",
      "public",
      { permissionId: Id<"permissions"> },
      null
    >;
    removePolicy: FunctionReference<
      "mutation",
      "public",
      { policyId: Id<"agentPolicies"> },
      null
    >;
    removeRole: FunctionReference<
      "mutation",
      "public",
      { roleId: Id<"orgRoles"> },
      null
    >;
    removeRule: FunctionReference<
      "mutation",
      "public",
      { policyId: Id<"agentPolicies">; ruleId: string },
      null
    >;
    updatePolicy: FunctionReference<
      "mutation",
      "public",
      {
        description?: string | null;
        mode?: "audit" | "enforce";
        name?: string;
        policyId: Id<"agentPolicies">;
      },
      null
    >;
    updateRole: FunctionReference<
      "mutation",
      "public",
      {
        description?: string | null;
        name?: string;
        policyIds?: Array<Id<"agentPolicies">>;
        roleId: Id<"orgRoles">;
      },
      null
    >;
    viewerPermissions: FunctionReference<
      "query",
      "public",
      { projectId?: Id<"projects"> },
      Array<"keys:read" | "keys:write" | "members:write" | "access:write">
    >;
  };
  account: {
    budget: {
      getForActiveOrg: FunctionReference<
        "query",
        "public",
        { month?: string; withProjects?: boolean },
        {
          caps: {
            egressGb: number;
            hostedMcpHours: number;
            sandboxHours: number;
            storageGb: number;
          } | null;
          days: Array<{
            day: string;
            egressGb: number;
            hostedMcpHours: number;
            ingressGb: number;
            sandboxHours: number;
            storageGb: number | null;
          }>;
          enforced: boolean;
          level: "ok" | "warning" | "exhausted";
          month: string;
          months: Array<string>;
          orgShares: {
            egressGb: number;
            hostedMcpHours: number;
            sandboxHours: number;
            storageGb: number;
          };
          plan: "free" | "pro";
          pool?: {
            orgs?: number;
            shared: boolean;
            totals: {
              egressGb: number;
              hostedMcpHours: number;
              ingressGb: number;
              sandboxHours: number;
              storageGb: number | null;
            };
          };
          projects?: Array<{
            days: Array<{
              day: string;
              egressGb: number;
              hostedMcpHours: number;
              ingressGb: number;
              sandboxHours: number;
              storageGb: number | null;
            }>;
            name: string;
            projectId: Id<"projects">;
            totals: {
              egressGb: number;
              hostedMcpHours: number;
              ingressGb: number;
              sandboxHours: number;
              storageGb: number | null;
            };
          }>;
          shares: {
            egressGb: number;
            hostedMcpHours: number;
            sandboxHours: number;
            storageGb: number;
          };
          totals: {
            egressGb: number;
            hostedMcpHours: number;
            ingressGb: number;
            sandboxHours: number;
            storageGb: number | null;
          };
          usedPercent: number | null;
        } | null
      >;
    };
    connectionsPublic: {
      disconnect: FunctionReference<
        "mutation",
        "public",
        { type: "chatgpt" },
        boolean
      >;
      list: FunctionReference<
        "query",
        "public",
        {},
        Array<{
          clientId: string;
          email?: string;
          expiresAt: number;
          hostId: string;
          scopes: Array<string>;
          type: "chatgpt";
          updatedAt: number;
        }>
      >;
    };
    storageTrust: {
      getForActiveOrg: FunctionReference<
        "mutation",
        "public",
        {},
        {
          externalId: string;
          principalArn?: string;
          trustPolicy?: string;
        } | null
      >;
    };
  };
  accountApiKeys: {
    create: FunctionReference<
      "mutation",
      "public",
      {
        actions: Array<
          | "account:read"
          | "account:write"
          | "agents:read"
          | "agents:write"
          | "audit:read"
          | "audit:write"
          | "channels:read"
          | "channels:write"
          | "crons:read"
          | "crons:write"
          | "env:read"
          | "env:write"
          | "hooks:read"
          | "hooks:write"
          | "mcp:read"
          | "mcp:write"
          | "policies:read"
          | "policies:write"
          | "sandboxes:read"
          | "sandboxes:write"
          | "skills:read"
          | "skills:write"
          | "workspaces:read"
          | "workspaces:write"
        >;
        description?: string;
        expiresAt?: number;
        name: string;
        orgId: Id<"orgs">;
        projectId?: Id<"projects">;
        stageId?: Id<"stages">;
      },
      { _id: Id<"accountApiKeys">; keyHint: string; token: string }
    >;
    remove: FunctionReference<
      "mutation",
      "public",
      { keyId: Id<"accountApiKeys">; orgId: Id<"orgs"> },
      Id<"accountApiKeys">
    >;
    update: FunctionReference<
      "mutation",
      "public",
      {
        actions?: Array<
          | "account:read"
          | "account:write"
          | "agents:read"
          | "agents:write"
          | "audit:read"
          | "audit:write"
          | "channels:read"
          | "channels:write"
          | "crons:read"
          | "crons:write"
          | "env:read"
          | "env:write"
          | "hooks:read"
          | "hooks:write"
          | "mcp:read"
          | "mcp:write"
          | "policies:read"
          | "policies:write"
          | "sandboxes:read"
          | "sandboxes:write"
          | "skills:read"
          | "skills:write"
          | "workspaces:read"
          | "workspaces:write"
        >;
        description?: string;
        expiresAt?: number | null;
        keyId: Id<"accountApiKeys">;
        name?: string;
        orgId: Id<"orgs">;
        scope?: { projectId?: Id<"projects">; stageId?: Id<"stages"> };
      },
      Id<"accountApiKeys">
    >;
  };
  agent: {
    agents: {
      listForProject: FunctionReference<
        "query",
        "public",
        { projectId: Id<"projects"> },
        Array<{ _id: Id<"agents">; name: string }>
      >;
    };
    config: {
      create: FunctionReference<
        "mutation",
        "public",
        {
          customBaseUrl?: string;
          description?: string;
          modelId?: string;
          name: string;
          position?: { x: number; y: number };
          projectId: Id<"projects">;
          provider?:
            | "alibaba"
            | "anthropic"
            | "azure"
            | "baseten"
            | "bedrock"
            | "cerebras"
            | "chatgpt"
            | "cloudflare"
            | "cohere"
            | "custom"
            | "deepinfra"
            | "deepseek"
            | "fireworks"
            | "google"
            | "groq"
            | "huggingface"
            | "llmgateway"
            | "minimax"
            | "mistral"
            | "moonshotai"
            | "ollama"
            | "openai"
            | "openrouter"
            | "perplexity"
            | "togetherai"
            | "v0"
            | "vercel"
            | "vertex"
            | "xai"
            | "zai";
          stageId: Id<"stages">;
          systemPrompt?: string;
        },
        Id<"agentConfigs">
      >;
      getById: FunctionReference<
        "query",
        "public",
        { configId: Id<"agentConfigs"> },
        null | {
          _creationTime: number;
          _id: Id<"agentConfigs">;
          agentId?: string;
          allowedTools?: Array<string>;
          authId: string;
          description?: string;
          extraConfig?: any;
          managedBy?: "cli" | "dashboard" | "api";
          maxTokens?: number;
          maxTurns?: number;
          memoryToolEnabled?: boolean;
          modelId?: string;
          name: string;
          outputFormat?: any;
          permissionMode?: string;
          projectId: Id<"projects">;
          provider?: string;
          providerOptions?: any;
          runtimeVariables?: Array<{ key: string; value: string }>;
          searchToolConfig?: any;
          searchToolEnabled?: boolean;
          stageId: Id<"stages">;
          systemPrompt?: string;
          temperature?: number;
          updatedAt: number;
        }
      >;
      remove: FunctionReference<
        "mutation",
        "public",
        { configId: Id<"agentConfigs"> },
        Id<"agentConfigs">
      >;
      setRequireUserToken: FunctionReference<
        "mutation",
        "public",
        { configId: Id<"agentConfigs">; required: boolean },
        null
      >;
      update: FunctionReference<
        "mutation",
        "public",
        {
          allowedTools?: Array<string>;
          configId: Id<"agentConfigs">;
          description?: string;
          extraConfig?: any;
          maxTokens?: number;
          maxTurns?: number;
          memoryToolEnabled?: boolean;
          modelId?: string;
          name?: string;
          outputFormat?: any;
          permissionMode?: string;
          provider?:
            | "alibaba"
            | "anthropic"
            | "azure"
            | "baseten"
            | "bedrock"
            | "cerebras"
            | "chatgpt"
            | "cloudflare"
            | "cohere"
            | "custom"
            | "deepinfra"
            | "deepseek"
            | "fireworks"
            | "google"
            | "groq"
            | "huggingface"
            | "llmgateway"
            | "minimax"
            | "mistral"
            | "moonshotai"
            | "ollama"
            | "openai"
            | "openrouter"
            | "perplexity"
            | "togetherai"
            | "v0"
            | "vercel"
            | "vertex"
            | "xai"
            | "zai";
          providerOptions?: any;
          runtimeVariables?: Array<{ key: string; value: string }>;
          searchToolConfig?: any;
          searchToolEnabled?: boolean;
          systemPrompt?: string;
          temperature?: number;
        },
        Id<"agentConfigs">
      >;
      updateRuntimeRefs: FunctionReference<
        "mutation",
        "public",
        {
          configId: Id<"agentConfigs">;
          sandboxes: Array<string>;
          workspaces: Array<{
            name: string;
            sandbox?: string | null;
            workspaceId: string;
          }> | null;
        },
        Id<"agentConfigs">
      >;
      updateSubagentRefs: FunctionReference<
        "mutation",
        "public",
        {
          calleeConfigIds: Array<Id<"agentConfigs">>;
          configId: Id<"agentConfigs">;
        },
        Id<"agentConfigs">
      >;
      userTokenRequirement: FunctionReference<
        "query",
        "public",
        { configId: Id<"agentConfigs"> },
        boolean | null
      >;
    };
    crons: {
      listForProject: FunctionReference<
        "query",
        "public",
        { projectId: Id<"projects"> },
        Array<{
          _creationTime: number;
          _id: Id<"crons">;
          accountId: Id<"accounts">;
          agentId: Id<"agents">;
          conversationKey?: string;
          createdAt: number;
          createdBy?: Id<"users">;
          creator?: { avatarUrl?: string; name: string };
          description?: string;
          events: Array<any>;
          lastError?: string;
          lastInvokedAt?: number;
          lastStatus?: "started" | "completed" | "failed";
          name: string;
          scheduleExpression: string;
          scheduledRunId?: Id<"_scheduled_functions">;
          status: "active" | "paused";
          timezone?: string;
          updatedAt: number;
        }>
      >;
      listRunsForProject: FunctionReference<
        "query",
        "public",
        { cronId: Id<"crons">; projectId: Id<"projects"> },
        Array<{
          _creationTime: number;
          _id: Id<"cronRuns">;
          accountId: Id<"accounts">;
          completedAt?: number;
          conversationKey: string;
          cronId: Id<"crons">;
          error?: string;
          eventId: string;
          startedAt: number;
          status: "started" | "completed" | "failed";
        }>
      >;
    };
    cronsPublic: {
      create: FunctionReference<
        "mutation",
        "public",
        {
          agentId: Id<"agents">;
          conversationKey?: string;
          description?: string;
          input: string;
          name: string;
          scheduleExpression: string;
          status: "active" | "paused";
          timezone?: string;
        },
        { cronId: string }
      >;
      remove: FunctionReference<"mutation", "public", { cronId: string }, null>;
      update: FunctionReference<
        "mutation",
        "public",
        {
          agentId?: Id<"agents">;
          conversationKey?: string;
          cronId: string;
          description?: string;
          input?: string;
          name?: string;
          scheduleExpression?: string;
          status?: "active" | "paused";
          timezone?: string;
        },
        null
      >;
    };
    deployments: {
      ensureForStage: FunctionReference<
        "mutation",
        "public",
        { projectId: Id<"projects">; stageId: Id<"stages"> },
        {
          _id: Id<"agentDeployments">;
          endpointId: string;
          keyHint: string;
          projectSlug: string;
          rawApiKey: string;
          stageSlug: string;
        }
      >;
      getForStage: FunctionReference<
        "query",
        "public",
        { projectId: Id<"projects">; stageId: Id<"stages"> },
        {
          _id: Id<"agentDeployments">;
          endpointId: string;
          keyHint: string;
          projectSlug: string;
          stageSlug: string;
          updatedAt: number;
        } | null
      >;
      mintStageSession: FunctionReference<
        "mutation",
        "public",
        { projectId: Id<"projects">; stageId: Id<"stages"> },
        { expiresAt: number; token: string } | null
      >;
      revealKeyForStage: FunctionReference<
        "query",
        "public",
        { projectId: Id<"projects">; stageId: Id<"stages"> },
        {
          apiKey: string;
          createdAt?: number;
          createdBy?: string;
          lastUsedAt?: number;
        } | null
      >;
      rotate: FunctionReference<
        "mutation",
        "public",
        { projectId: Id<"projects">; stageId: Id<"stages"> },
        {
          _id: Id<"agentDeployments">;
          endpointId: string;
          keyHint: string;
          projectSlug: string;
          rawApiKey: string;
          stageSlug: string;
        }
      >;
      rotateUserTokenSecret: FunctionReference<
        "mutation",
        "public",
        { projectId: Id<"projects">; stageId: Id<"stages"> },
        { hint: string; secret: string }
      >;
      userTokenSecretForStage: FunctionReference<
        "query",
        "public",
        { projectId: Id<"projects">; stageId: Id<"stages"> },
        { createdAt?: number; hint: string } | null
      >;
    };
    policies: {
      create: FunctionReference<
        "mutation",
        "public",
        {
          description?: string;
          document: any;
          name: string;
          projectId: Id<"projects">;
          stageId: Id<"stages">;
        },
        Id<"agentPolicies">
      >;
      listForStage: FunctionReference<
        "query",
        "public",
        { projectId: Id<"projects">; stageId: Id<"stages"> },
        Array<{
          _creationTime: number;
          _id: Id<"agentPolicies">;
          accountId: Id<"accounts">;
          createdAt: number;
          createdBy?: Id<"users">;
          deletedAt?: number;
          description?: string;
          document: {
            mode?: "enforce" | "audit";
            rules: Array<{
              actions: Array<string>;
              conditions?: Array<{
                attribute: string;
                operator:
                  | "equals"
                  | "notEquals"
                  | "in"
                  | "notIn"
                  | "prefix"
                  | "contains";
                value:
                  | string
                  | number
                  | boolean
                  | Array<string>
                  | Array<number>
                  | Array<boolean>;
              }>;
              effect: "allow" | "deny";
              id: string;
              resources?: {
                filePaths?: Array<string>;
                mcpIds?: Array<string>;
                resourceIds?: Array<string>;
                skillPaths?: Array<string>;
                subagentIds?: Array<string>;
                toolNames?: Array<string>;
                workspaceIds?: Array<string>;
                workspaceNames?: Array<string>;
              };
            }>;
            version: 1;
          };
          managedBy?: "cli" | "dashboard" | "api";
          name: string;
          projectId?: Id<"projects">;
          stageId?: Id<"stages">;
          status: "active" | "deleted";
          updatedAt: number;
        }>
      >;
      remove: FunctionReference<
        "mutation",
        "public",
        { policyId: Id<"agentPolicies"> },
        Id<"agentPolicies">
      >;
      update: FunctionReference<
        "mutation",
        "public",
        {
          description?: string | null;
          document?: any;
          name?: string;
          policyId: Id<"agentPolicies">;
        },
        Id<"agentPolicies">
      >;
      usageCounts: FunctionReference<
        "query",
        "public",
        { projectId: Id<"projects">; stageId: Id<"stages"> },
        Record<string, number>
      >;
    };
  };
  apiKeys: {
    listForOrg: FunctionReference<
      "query",
      "public",
      {},
      {
        keys: Array<{
          _id?: Id<"accountApiKeys">;
          actions?: Array<
            | "account:read"
            | "account:write"
            | "agents:read"
            | "agents:write"
            | "audit:read"
            | "audit:write"
            | "channels:read"
            | "channels:write"
            | "crons:read"
            | "crons:write"
            | "env:read"
            | "env:write"
            | "hooks:read"
            | "hooks:write"
            | "mcp:read"
            | "mcp:write"
            | "policies:read"
            | "policies:write"
            | "sandboxes:read"
            | "sandboxes:write"
            | "skills:read"
            | "skills:write"
            | "workspaces:read"
            | "workspaces:write"
          >;
          createdAt: number;
          createdBy?: { avatarUrl?: string; name: string };
          description?: string;
          expiresAt?: number;
          keyHint?: string;
          lastUsedAt?: number;
          name: string;
          projectId?: Id<"projects">;
          stageId?: Id<"stages">;
        }>;
        stages: Array<{
          projectId: Id<"projects">;
          projectName: string;
          stageId: Id<"stages">;
          stageName: string;
        }>;
      } | null
    >;
    listForProject: FunctionReference<
      "query",
      "public",
      { projectId: Id<"projects"> },
      {
        api: Array<{
          _id: Id<"deployKeys">;
          createdAt: number;
          createdBy?: { avatarUrl?: string; name: string };
          description?: string;
          keyHint: string;
          lastUsedAt?: number;
          name: string;
          stageId: Id<"stages">;
          stageName: string;
        }>;
        runtime: Array<{
          keyHint: string;
          lastUsedAt?: number;
          rotatedAt?: number;
          rotatedBy?: { avatarUrl?: string; name: string };
          stageId: Id<"stages">;
          stageName: string;
        }>;
        writable: Array<{ _id: Id<"stages">; name: string }>;
      } | null
    >;
  };
  canvas: {
    cliManagedResourceNames: FunctionReference<
      "query",
      "public",
      { projectId: Id<"projects">; stageId: Id<"stages"> },
      { agent: Array<string>; sandbox: Array<string>; workspace: Array<string> }
    >;
    getByProject: FunctionReference<
      "query",
      "public",
      { projectId: Id<"projects">; stageId?: Id<"stages"> },
      null | {
        edges: Array<{
          animated?: boolean;
          id: string;
          source: string;
          target: string;
        }>;
        nodes: Array<{
          data: any;
          id: string;
          position: { x: number; y: number };
          type: "agent" | "sandbox" | "workspace" | "mcp" | "skill";
        }>;
      }
    >;
    resourceOwnership: FunctionReference<
      "query",
      "public",
      { projectId: Id<"projects">; stageId: Id<"stages"> },
      Record<string, "cli" | "dashboard" | "api">
    >;
    saveLayout: FunctionReference<
      "mutation",
      "public",
      {
        edges: Array<{
          animated?: boolean;
          id: string;
          source: string;
          target: string;
        }>;
        nodes: Array<{
          data: any;
          id: string;
          position: { x: number; y: number };
          type: "agent" | "sandbox" | "workspace" | "mcp" | "skill";
        }>;
        projectId: Id<"projects">;
        stageId: Id<"stages">;
      },
      {
        edges: Array<{
          animated?: boolean;
          id: string;
          source: string;
          target: string;
        }>;
        layoutId: Id<"canvasLayouts">;
        nodes: Array<{
          data: any;
          id: string;
          position: { x: number; y: number };
          type: "agent" | "sandbox" | "workspace" | "mcp" | "skill";
        }>;
      }
    >;
  };
  cli: {
    auth: {
      createLoginCode: FunctionReference<
        "mutation",
        "public",
        { codeChallenge: string },
        { code: string; expiresAt: number }
      >;
    };
  };
  deployKeys: {
    create: FunctionReference<
      "mutation",
      "public",
      {
        description?: string;
        name: string;
        projectId: Id<"projects">;
        stageId: Id<"stages">;
      },
      { _id: Id<"deployKeys">; keyHint: string; token: string }
    >;
    list: FunctionReference<
      "query",
      "public",
      { projectId: Id<"projects">; stageId: Id<"stages"> },
      Array<{
        _creationTime: number;
        _id: Id<"deployKeys">;
        accountId: Id<"accounts">;
        createdAt: number;
        createdBy?: Id<"users">;
        description?: string;
        keyHint: string;
        lastUsedAt?: number;
        name: string;
        projectId: Id<"projects">;
        stageId: Id<"stages">;
        status: "active" | "revoked";
        updatedAt: number;
      }>
    >;
    remove: FunctionReference<
      "mutation",
      "public",
      { deployKeyId: Id<"deployKeys"> },
      Id<"deployKeys">
    >;
  };
  environmentVariables: {
    list: FunctionReference<
      "query",
      "public",
      { projectId: Id<"projects">; stageId: Id<"stages"> },
      Array<{
        _creationTime: number;
        _id: Id<"environmentVariables">;
        name: string;
        projectId: Id<"projects">;
        stageId: Id<"stages">;
        updatedAt: number;
        value: string;
      }>
    >;
    remove: FunctionReference<
      "mutation",
      "public",
      { variableId: Id<"environmentVariables"> },
      Id<"environmentVariables">
    >;
    reveal: FunctionReference<
      "mutation",
      "public",
      {
        projectId: Id<"projects">;
        stageId: Id<"stages">;
        variableId: Id<"environmentVariables">;
      },
      { value: string }
    >;
    set: FunctionReference<
      "mutation",
      "public",
      {
        name: string;
        projectId: Id<"projects">;
        stageId: Id<"stages">;
        value: string;
      },
      Id<"environmentVariables">
    >;
  };
  logs: {
    fetchUsageStats: FunctionReference<
      "query",
      "public",
      {
        projectId: Id<"projects">;
        range: "1h" | "3h" | "1d" | "7d" | "30d" | "1y";
        stageId?: Id<"stages">;
      },
      {
        binSeconds: number;
        buckets: Array<{
          agentSandboxCpuUsec: number;
          bucketStart: number;
          cacheWriteTokens: number;
          cachedInputTokens: number;
          inputTokens: number;
          invocations: number;
          modelCalls: number;
          modelId: string;
          modelProvider: string;
          outputTokens: number;
          reasoningTokens: number;
          runtimeWallMs: number;
          toolSandboxCpuUsec: number;
          totalTokens: number;
        }>;
        endTimeMs: number;
        range: "1h" | "3h" | "1d" | "7d" | "30d" | "1y";
        startTimeMs: number;
        totals: {
          agentSandboxCpuUsec: number;
          cacheWriteTokens: number;
          cachedInputTokens: number;
          inputTokens: number;
          invocations: number;
          modelCalls: number;
          outputTokens: number;
          reasoningTokens: number;
          runtimeWallMs: number;
          toolSandboxCpuUsec: number;
          totalTokens: number;
        };
      }
    >;
    fetchUsageTasks: FunctionReference<
      "query",
      "public",
      {
        endMs: number;
        models?: Array<string>;
        projectId: Id<"projects">;
        stageId?: Id<"stages">;
        startMs: number;
      },
      {
        tasks: Array<{
          agentId: string;
          cacheWriteTokens: number;
          cachedInputTokens: number;
          durationMs: number;
          finishedAt: number;
          inputPreview: string | null;
          inputTokens: number;
          modelId: string;
          modelProvider: string;
          outputTokens: number;
          reasoningTokens: number;
          status: "completed" | "failed";
          stepCount: number;
          totalTokens: number;
          traceId: string | null;
        }>;
        truncated: boolean;
      }
    >;
  };
  mcp: {
    callTool: FunctionReference<
      "action",
      "public",
      {
        input?: any;
        nodeId: string;
        projectId: Id<"projects">;
        stageId: Id<"stages">;
        toolName: string;
      },
      { durationMs: number; result: any }
    >;
    getByNode: FunctionReference<
      "query",
      "public",
      { nodeId: string; projectId: Id<"projects">; stageId: Id<"stages"> },
      null | {
        _creationTime: number;
        _id: Id<"mcp">;
        accountId: Id<"accounts">;
        allowedTools?: Array<string>;
        bundleStorageKey?: string;
        command?: Array<string>;
        createdAt: number;
        deletedAt?: number;
        description?: string;
        disabled?: boolean;
        headers?: Record<string, string>;
        name: string;
        nodeId?: string;
        oauth?: {
          clientId: string;
          clientSecret: string;
          refreshToken: string;
          tokenUrl?: string;
        };
        projectId: Id<"projects">;
        runtime?: "auto" | "lambda";
        sandbox?: string;
        sha256?: string;
        sourceCode?: string;
        stageId: Id<"stages">;
        status: "active" | "deleted";
        transport: "http" | "hosted" | "machine";
        updatedAt: number;
        url?: string;
        workersCompatible?: boolean;
      }
    >;
    listByStage: FunctionReference<
      "query",
      "public",
      { projectId: Id<"projects">; stageId?: Id<"stages"> },
      Array<{
        disabled: boolean;
        name: string;
        nodeId: string;
        sandbox: string | null;
        transport: "http" | "hosted" | "machine";
      }>
    >;
    listTools: FunctionReference<
      "action",
      "public",
      { nodeId: string; projectId: Id<"projects">; stageId: Id<"stages"> },
      Array<any>
    >;
    removeForNode: FunctionReference<
      "action",
      "public",
      { nodeId: string; projectId: Id<"projects">; stageId: Id<"stages"> },
      null
    >;
    saveForNode: FunctionReference<
      "action",
      "public",
      {
        bundle?: string;
        description?: string;
        disabled?: boolean;
        headers?: Record<string, string>;
        nodeId: string;
        nodeLabel: string;
        projectId: Id<"projects">;
        runtime?: "auto" | "lambda";
        sourceCode?: string;
        stageId: Id<"stages">;
        url?: string;
      },
      { serverId: Id<"mcp">; tools: Array<any>; verified: boolean }
    >;
  };
  org: {
    lifecycle: {
      provision: FunctionReference<
        "action",
        "public",
        { orgId: Id<"orgs"> },
        { accountId: Id<"accounts">; secret: string }
      >;
      rotateSecret: FunctionReference<
        "action",
        "public",
        { orgId: Id<"orgs"> },
        { secret: string }
      >;
    };
    members: {
      add: FunctionReference<
        "mutation",
        "public",
        {
          email: string;
          orgId: Id<"orgs">;
          role?: "owner" | "admin" | "member";
          roleId?: Id<"orgRoles">;
        },
        Id<"orgMembers">
      >;
      list: FunctionReference<
        "query",
        "public",
        { orgId: Id<"orgs"> },
        Array<{
          avatarUrl?: string;
          createdAt: number;
          email: string;
          invitedBy?: { avatarUrl?: string; name: string };
          isOwner: boolean;
          membershipId: Id<"orgMembers">;
          name: string;
          role: "owner" | "admin" | "member";
          roleId?: Id<"orgRoles">;
          roleName?: string;
          userId: Id<"users">;
        }>
      >;
      remove: FunctionReference<
        "mutation",
        "public",
        { membershipId: Id<"orgMembers"> },
        null
      >;
      updateRole: FunctionReference<
        "mutation",
        "public",
        {
          membershipId: Id<"orgMembers">;
          role: "owner" | "admin" | "member";
          roleId?: Id<"orgRoles">;
        },
        null
      >;
    };
    orgs: {
      create: FunctionReference<
        "mutation",
        "public",
        { name: string },
        Id<"orgs">
      >;
      getActive: FunctionReference<
        "query",
        "public",
        {},
        {
          _creationTime: number;
          _id: Id<"orgs">;
          createdAt: number;
          name: string;
          onboardedAt?: number;
          ownerAuthId: string;
          plan: "free" | "pro";
          slug: string;
        } | null
      >;
      getActiveAccount: FunctionReference<
        "query",
        "public",
        { requiredRole?: "owner" | "admin" | "member" },
        {
          accountId: Id<"accounts">;
          role: "owner" | "admin" | "member";
          status: "active" | "disabled";
        } | null
      >;
      getOrCreate: FunctionReference<
        "mutation",
        "public",
        {},
        { needsProvision: boolean; orgId: Id<"orgs"> }
      >;
      list: FunctionReference<
        "query",
        "public",
        {},
        Array<{
          _creationTime: number;
          _id: Id<"orgs">;
          createdAt: number;
          name: string;
          onboardedAt?: number;
          ownerAuthId: string;
          plan: "free" | "pro";
          slug: string;
        }>
      >;
      remove: FunctionReference<
        "mutation",
        "public",
        { orgId: Id<"orgs"> },
        null
      >;
      setActive: FunctionReference<
        "mutation",
        "public",
        { orgId: Id<"orgs"> },
        null
      >;
      update: FunctionReference<
        "mutation",
        "public",
        { name?: string; orgId: Id<"orgs"> },
        null
      >;
    };
  };
  project: {
    create: FunctionReference<
      "mutation",
      "public",
      { description?: string; name: string },
      Id<"projects">
    >;
    getById: FunctionReference<
      "query",
      "public",
      { projectId: Id<"projects"> },
      null | {
        _creationTime: number;
        _id: Id<"projects">;
        authId: string;
        description?: string;
        name: string;
        orgId: Id<"orgs">;
        slug: string;
        updatedAt: number;
      }
    >;
    list: FunctionReference<
      "query",
      "public",
      {},
      Array<{
        _creationTime: number;
        _id: Id<"projects">;
        authId: string;
        description?: string;
        name: string;
        orgId: Id<"orgs">;
        slug: string;
        updatedAt: number;
      }>
    >;
    openHome: FunctionReference<
      "mutation",
      "public",
      { project?: string; stage?: string },
      {
        needsProvision: boolean;
        orgId: Id<"orgs">;
        projectId: null | Id<"projects">;
        stageId: null | Id<"stages">;
      }
    >;
    remove: FunctionReference<
      "mutation",
      "public",
      { projectId: Id<"projects"> },
      Id<"projects">
    >;
    update: FunctionReference<
      "mutation",
      "public",
      { description?: string; name: string; projectId: Id<"projects"> },
      Id<"projects">
    >;
  };
  sandbox: {
    auditEvents: {
      listForInstance: FunctionReference<
        "query",
        "public",
        { limit?: number; reservationKey: string },
        Array<{
          _creationTime: number;
          _id: Id<"sandboxAuditEvents">;
          accountId: Id<"accounts">;
          action:
            | "reserve"
            | "suspend"
            | "resume"
            | "terminate"
            | "snapshot"
            | "refresh"
            | "exec"
            | "terminal";
          actorEmail?: string;
          actorId?: string;
          actorName?: string;
          actorSource: "dashboard" | "agent" | "service" | "unknown";
          createdAt: number;
          durationMs?: number;
          errorMessage?: string;
          exitCode?: number;
          projectId?: Id<"projects">;
          provider:
            | "sandbox"
            | "lambda"
            | "e2b"
            | "daytona"
            | "vercel"
            | "cloudflare"
            | "worker"
            | "machine"
            | "custom";
          reservationKey: string;
          result: "ok" | "error";
          sandboxConfigId?: Id<"sandboxConfigs">;
          stageId?: Id<"stages">;
          status?:
            "running" | "suspending" | "suspended" | "terminating" | "error";
          taskId?: string;
          traceId?: string;
          truncated?: boolean;
        }>
      >;
    };
    instances: {
      listForActiveOrg: FunctionReference<
        "query",
        "public",
        { projectId: Id<"projects">; stageId: Id<"stages"> },
        Array<{
          _creationTime: number;
          _id: Id<"sandboxInstances">;
          accountId: Id<"accounts">;
          agentId?: string;
          burstBilled?: { gbSeconds: number; vcpuSeconds: number };
          conversationKey?: string;
          createdAt: number;
          createdByTaskId?: string;
          createdByTraceId?: string;
          egress?: "allow-all" | "deny-all" | "restricted";
          ephemeral?: boolean;
          errorMessage?: string;
          externalId: string;
          idleTimeoutSeconds?: number;
          lastUsedAt: number;
          lastUsedTaskId?: string;
          lastUsedTraceId?: string;
          logStream?: string;
          meteredUntil?: number;
          name: string;
          ownCredentials?: boolean;
          permissionMode?: "edit" | "ask" | "bypass";
          projectId?: Id<"projects">;
          provider:
            | "sandbox"
            | "lambda"
            | "e2b"
            | "daytona"
            | "vercel"
            | "cloudflare"
            | "worker"
            | "machine"
            | "custom";
          reservationKey: string;
          sandboxConfigId?: Id<"sandboxConfigs">;
          snapshotId?: string;
          specs: { memoryMb: number; storageGb?: number; vcpu: number };
          specsVerified?: boolean;
          stageId?: Id<"stages">;
          status:
            "running" | "suspending" | "suspended" | "terminating" | "error";
          suspendedAt?: number;
          workspaceId?: string;
          workspaceName?: string;
        }>
      >;
    };
    machines: {
      listForActiveOrg: FunctionReference<
        "query",
        "public",
        { projectId: Id<"projects">; stageId?: Id<"stages"> },
        Array<{
          _creationTime: number;
          _id: Id<"machineConnections">;
          accountId: Id<"accounts">;
          computer: boolean;
          connectedAt: number;
          connectionId: string;
          disconnectedAt?: number;
          hostname?: string;
          lastSeenAt: number;
          mcp: Array<string>;
          name: string;
          platform?: string;
          projectId?: Id<"projects">;
          sandboxConfigId: Id<"sandboxConfigs">;
          specs?: { memoryMb: number; storageGb?: number; vcpu: number };
          stageId?: Id<"stages">;
        }>
      >;
    };
    public: {
      createSnapshot: FunctionReference<
        "action",
        "public",
        {
          name: string;
          reservationKey: string;
          sandboxId: Id<"sandboxConfigs">;
        },
        null
      >;
      openTerminal: FunctionReference<
        "action",
        "public",
        { reservationKey: string; sandboxId: Id<"sandboxConfigs"> },
        { expiresAt: number; token: string; websocketPath: string }
      >;
      refreshSandbox: FunctionReference<
        "action",
        "public",
        { reservationKey: string; sandboxId: Id<"sandboxConfigs"> },
        null
      >;
      resumeSandbox: FunctionReference<
        "action",
        "public",
        { reservationKey: string; sandboxId: Id<"sandboxConfigs"> },
        null
      >;
      runSandboxCommand: FunctionReference<
        "action",
        "public",
        {
          code: string;
          reservationKey: string;
          sandboxId: Id<"sandboxConfigs">;
        },
        {
          durationMs: number;
          exitCode: number | null;
          ok: boolean;
          provider: string;
          runtime: string;
          stderr: string;
          stdout: string;
          truncated: boolean;
        }
      >;
      suspendSandbox: FunctionReference<
        "action",
        "public",
        { reservationKey: string; sandboxId: Id<"sandboxConfigs"> },
        null
      >;
      terminateSandbox: FunctionReference<
        "action",
        "public",
        { reservationKey: string; sandboxId: Id<"sandboxConfigs"> },
        null
      >;
    };
    snapshots: {
      listForActiveOrg: FunctionReference<
        "query",
        "public",
        {},
        Array<{
          _creationTime: number;
          _id: Id<"sandboxSnapshots">;
          accountId: Id<"accounts">;
          baseImage: string;
          createdAt: number;
          externalImageId: string;
          lastUsedAt: number;
          name: string;
          provider:
            | "sandbox"
            | "lambda"
            | "e2b"
            | "daytona"
            | "vercel"
            | "cloudflare"
            | "worker"
            | "machine"
            | "custom";
          pulledCount: number;
          scope?:
            "account" | { projectId: Id<"projects">; stageId: Id<"stages"> };
          stageName?: string;
          status:
            | "pending"
            | "building"
            | "pulling"
            | "active"
            | "inactive"
            | "error"
            | "build_failed";
        }>
      >;
    };
  };
  skillsPublic: {
    createFromGithub: FunctionReference<
      "action",
      "public",
      { bearerToken: string; githubUrl: string },
      { description: string; name: string; path: string }
    >;
    createFromJson: FunctionReference<
      "action",
      "public",
      {
        bearerToken: string;
        content: string;
        description: string;
        name: string;
      },
      { description: string; name: string; path: string }
    >;
    publishSkill: FunctionReference<
      "action",
      "public",
      { bearerToken: string; nodeId: string; projectId: Id<"projects"> },
      { description: string; name: string; path: string; sizeBytes: number }
    >;
  };
  stage: {
    create: FunctionReference<
      "mutation",
      "public",
      {
        duplicateFromId?: Id<"stages">;
        name: string;
        projectId: Id<"projects">;
      },
      Id<"stages">
    >;
    ensureDefault: FunctionReference<
      "mutation",
      "public",
      { projectId: Id<"projects"> },
      null | Id<"stages">
    >;
    initializeProduction: FunctionReference<
      "mutation",
      "public",
      {
        deploymentRegion: "ap-southeast-1" | "eu-west-1" | "us-east-1";
        projectId: Id<"projects">;
        sourceStageId: Id<"stages">;
      },
      Id<"stages">
    >;
    list: FunctionReference<
      "query",
      "public",
      { projectId: Id<"projects"> },
      Array<{
        _creationTime: number;
        _id: Id<"stages">;
        authId: string;
        deploymentRegion?: "ap-southeast-1" | "eu-west-1" | "us-east-1";
        isDefault: boolean;
        kind: "development" | "production" | "custom";
        name: string;
        projectId: Id<"projects">;
        updatedAt: number;
      }>
    >;
    remove: FunctionReference<
      "mutation",
      "public",
      { stageId: Id<"stages"> },
      Id<"stages">
    >;
  };
  stripe: {
    addSeat: FunctionReference<"action", "public", {}, { seats: number }>;
    createCheckoutSession: FunctionReference<
      "action",
      "public",
      { cancelUrl: string; successUrl: string },
      { url: string }
    >;
    createPortalSession: FunctionReference<
      "action",
      "public",
      { returnUrl: string },
      { url: string }
    >;
    getBillingInfo: FunctionReference<
      "query",
      "public",
      {},
      | null
      | {
          developers: number;
          kind: "owner";
          seats: number;
          subscription: null | {
            cancelAtPeriodEnd: boolean;
            currentPeriodEnd: number;
            status: string;
          };
        }
      | { kind: "member"; status: null | string }
    >;
    listOwnedOrgs: FunctionReference<
      "query",
      "public",
      {},
      Array<{ name: string; orgId: Id<"orgs">; plan: "free" | "pro" }>
    >;
    listSeatHolders: FunctionReference<
      "query",
      "public",
      {},
      Array<{ name: string; orgs: Array<string>; userId: Id<"users"> }>
    >;
  };
  user: {
    analyticsId: FunctionReference<"query", "public", {}, null | string>;
    ensureSynced: FunctionReference<"action", "public", {}, null>;
    getCurrent: FunctionReference<
      "query",
      "public",
      {},
      null | {
        _creationTime: number;
        _id: Id<"users">;
        accountHandle?: string;
        activeOrgId?: Id<"orgs">;
        authId: string;
        avatarUrl?: string;
        deletionScheduledFor?: number;
        email: string;
        name: string;
        nameEdited?: boolean;
        plan: "free" | "pro";
        workosDeletionAttempts?: number;
        workosDeletionRequestedAt?: number;
      }
    >;
    requestAccountDeletion: FunctionReference<
      "mutation",
      "public",
      {},
      { scheduledFor: number }
    >;
    syncProfile: FunctionReference<
      "mutation",
      "public",
      { avatarUrl: string },
      null
    >;
    updateProfile: FunctionReference<
      "mutation",
      "public",
      { accountHandle?: string; name: string },
      Id<"users">
    >;
  };
  webhooks: {
    addAgentWebhook: FunctionReference<
      "mutation",
      "public",
      {
        agentConfigId: Id<"agentConfigs">;
        enabled?: boolean;
        events?: Array<string>;
        secret: string;
        url: string;
      },
      null
    >;
    listAgentWebhooks: FunctionReference<
      "query",
      "public",
      { projectId: Id<"projects">; stageId: Id<"stages"> },
      Array<{
        agentConfigId: Id<"agentConfigs">;
        agentName: string;
        webhooks: Array<{
          enabled: boolean;
          events: Array<string>;
          hasSecret: boolean;
          index: number;
          url?: string;
        }>;
      }>
    >;
    removeAgentWebhook: FunctionReference<
      "mutation",
      "public",
      { agentConfigId: Id<"agentConfigs">; index: number },
      null
    >;
    setAgentWebhookEnabled: FunctionReference<
      "mutation",
      "public",
      { agentConfigId: Id<"agentConfigs">; enabled: boolean; index: number },
      null
    >;
  };
  workspace: {
    files: {
      create: FunctionReference<
        "mutation",
        "public",
        {
          isFolder: boolean;
          mimeType?: string;
          name: string;
          nodeId: string;
          path: string;
          projectId: Id<"projects">;
          storageId?: Id<"_storage">;
        },
        Id<"workspaceFiles">
      >;
      generateUploadUrl: FunctionReference<"mutation", "public", {}, string>;
      getFileDownloadUrl: FunctionReference<
        "query",
        "public",
        { nodeId: string; path: string; projectId: Id<"projects"> },
        string | null
      >;
      list: FunctionReference<
        "query",
        "public",
        { nodeId: string; projectId: Id<"projects"> },
        Array<{
          _creationTime: number;
          _id: Id<"workspaceFiles">;
          authId: string;
          createdAt: number;
          isFolder: boolean;
          mimeType?: string;
          name: string;
          nodeId: string;
          path: string;
          projectId: Id<"projects">;
          sizeBytes?: number;
          storageId?: Id<"_storage">;
          updatedAt: number;
        }>
      >;
      remove: FunctionReference<
        "mutation",
        "public",
        { fileId: Id<"workspaceFiles"> },
        null
      >;
      removeFolder: FunctionReference<
        "mutation",
        "public",
        { folderPath: string; nodeId: string; projectId: Id<"projects"> },
        null
      >;
      rename: FunctionReference<
        "mutation",
        "public",
        { fileId: Id<"workspaceFiles">; newName: string },
        null
      >;
    };
    filesPublic: {
      list: FunctionReference<
        "action",
        "public",
        { projectId: Id<"projects">; workspaceId: string },
        Array<{
          isFolder: boolean;
          name: string;
          path: string;
          sizeBytes?: number;
          updatedAt?: string;
        }>
      >;
      remove: FunctionReference<
        "action",
        "public",
        { path: string; projectId: Id<"projects">; workspaceId: string },
        null
      >;
      rename: FunctionReference<
        "action",
        "public",
        {
          newPath: string;
          path: string;
          projectId: Id<"projects">;
          workspaceId: string;
        },
        null
      >;
      upload: FunctionReference<
        "action",
        "public",
        {
          contentBase64: string;
          contentType?: string;
          path: string;
          projectId: Id<"projects">;
          workspaceId: string;
        },
        {
          isFolder: boolean;
          name: string;
          path: string;
          sizeBytes?: number;
          updatedAt?: string;
        }
      >;
    };
  };
};

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: {
  account: {
    accounts: {
      create: FunctionReference<
        "mutation",
        "internal",
        {
          description?: string;
          orgId: string;
          secretHash: string;
          secretHint?: string;
          secretRotatedBy?: Id<"users">;
          status?: "active" | "disabled";
          username: string;
        },
        {
          _creationTime: number;
          _id: Id<"accounts">;
          auditRetentionDays?: number;
          createdAt: number;
          description?: string;
          orgId: string;
          secretHash: string;
          secretHint?: string;
          secretRotatedAt?: number;
          secretRotatedBy?: Id<"users">;
          status: "active" | "disabled";
          storageExternalId?: string;
          updatedAt: number;
          username: string;
        }
      >;
      getById: FunctionReference<
        "query",
        "internal",
        { accountId: string },
        {
          _creationTime: number;
          _id: Id<"accounts">;
          auditRetentionDays?: number;
          createdAt: number;
          description?: string;
          orgId: string;
          secretHash: string;
          secretHint?: string;
          secretRotatedAt?: number;
          secretRotatedBy?: Id<"users">;
          status: "active" | "disabled";
          storageExternalId?: string;
          updatedAt: number;
          username: string;
        } | null
      >;
      getByOrgId: FunctionReference<
        "query",
        "internal",
        { orgId: string },
        {
          _creationTime: number;
          _id: Id<"accounts">;
          auditRetentionDays?: number;
          createdAt: number;
          description?: string;
          orgId: string;
          secretHash: string;
          secretHint?: string;
          secretRotatedAt?: number;
          secretRotatedBy?: Id<"users">;
          status: "active" | "disabled";
          storageExternalId?: string;
          updatedAt: number;
          username: string;
        } | null
      >;
      getBySecretHash: FunctionReference<
        "query",
        "internal",
        { secretHash: string },
        {
          _creationTime: number;
          _id: Id<"accounts">;
          auditRetentionDays?: number;
          createdAt: number;
          description?: string;
          orgId: string;
          secretHash: string;
          secretHint?: string;
          secretRotatedAt?: number;
          secretRotatedBy?: Id<"users">;
          status: "active" | "disabled";
          storageExternalId?: string;
          updatedAt: number;
          username: string;
        } | null
      >;
      list: FunctionReference<
        "query",
        "internal",
        {},
        Array<{
          _creationTime: number;
          _id: Id<"accounts">;
          auditRetentionDays?: number;
          createdAt: number;
          description?: string;
          orgId: string;
          secretHash: string;
          secretHint?: string;
          secretRotatedAt?: number;
          secretRotatedBy?: Id<"users">;
          status: "active" | "disabled";
          storageExternalId?: string;
          updatedAt: number;
          username: string;
        }>
      >;
      remove: FunctionReference<
        "mutation",
        "internal",
        { accountId: Id<"accounts"> },
        null
      >;
      removeBatch: FunctionReference<
        "mutation",
        "internal",
        { accountId: Id<"accounts"> },
        boolean
      >;
      update: FunctionReference<
        "mutation",
        "internal",
        {
          accountId: Id<"accounts">;
          auditRetentionDays?: number | null;
          description?: string | null;
          secretHash?: string;
          secretHint?: string;
          secretRotatedBy?: Id<"users">;
          status?: "active" | "disabled";
          username?: string;
        },
        {
          _creationTime: number;
          _id: Id<"accounts">;
          auditRetentionDays?: number;
          createdAt: number;
          description?: string;
          orgId: string;
          secretHash: string;
          secretHint?: string;
          secretRotatedAt?: number;
          secretRotatedBy?: Id<"users">;
          status: "active" | "disabled";
          storageExternalId?: string;
          updatedAt: number;
          username: string;
        } | null
      >;
    };
    apiKeys: {
      resolve: FunctionReference<
        "query",
        "internal",
        { keyHash: string; now: number },
        {
          account: {
            _creationTime: number;
            _id: Id<"accounts">;
            auditRetentionDays?: number;
            createdAt: number;
            description?: string;
            orgId: string;
            secretHash: string;
            secretHint?: string;
            secretRotatedAt?: number;
            secretRotatedBy?: Id<"users">;
            status: "active" | "disabled";
            storageExternalId?: string;
            updatedAt: number;
            username: string;
          };
          keyId: Id<"accountApiKeys">;
          principal: {
            accountId: Id<"accounts">;
            policy: {
              mode?: "enforce" | "audit";
              rules: Array<{
                actions: Array<string>;
                conditions?: Array<{
                  attribute: string;
                  operator:
                    | "equals"
                    | "notEquals"
                    | "in"
                    | "notIn"
                    | "prefix"
                    | "contains";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | Array<boolean>;
                }>;
                effect: "allow" | "deny";
                id: string;
                resources?: {
                  filePaths?: Array<string>;
                  mcpIds?: Array<string>;
                  resourceIds?: Array<string>;
                  skillPaths?: Array<string>;
                  subagentIds?: Array<string>;
                  toolNames?: Array<string>;
                  workspaceIds?: Array<string>;
                  workspaceNames?: Array<string>;
                };
              }>;
              version: 1;
            };
            projectId?: Id<"projects">;
            roleId: string;
            stageId?: Id<"stages">;
          };
          stampDue: boolean;
        } | null
      >;
      touchLastUsed: FunctionReference<
        "mutation",
        "internal",
        { keyId: Id<"accountApiKeys">; usedAt: number },
        null
      >;
    };
    budget: {
      claimWarning: FunctionReference<
        "mutation",
        "internal",
        { accountId: string },
        boolean
      >;
      get: FunctionReference<
        "query",
        "internal",
        { accountId: string },
        {
          enforced: boolean;
          month: string;
          plan: "free" | "pro";
          runsPerMinute: number;
          shares: {
            egressGb: number;
            hostedMcpHours: number;
            sandboxHours: number;
            storageGb: number;
          };
          usedPercent: number;
          warned: boolean;
        } | null
      >;
      listAccountIds: FunctionReference<
        "query",
        "internal",
        {
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
        },
        { continueCursor: string; isDone: boolean; page: Array<Id<"accounts">> }
      >;
      listWorkspaces: FunctionReference<
        "query",
        "internal",
        {
          accountId: Id<"accounts">;
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            projectId?: Id<"projects">;
            workspaceId: Id<"workspaceConfigs">;
          }>;
        }
      >;
      pruneUsageWrites: FunctionReference<"mutation", "internal", {}, null>;
      record: FunctionReference<
        "mutation",
        "internal",
        {
          accountId: string;
          at?: number;
          projectStorage?: Array<{
            projectId: Id<"projects">;
            storageGbMonths: number;
          }>;
          source?: {
            agentId?: string;
            projectId?: string;
            workspaceId?: string;
          };
          usage: {
            egressGb?: number;
            hostedMcpGbSeconds?: number;
            hostedMcpRequests?: number;
            ingressGb?: number;
            storageGbMonths?: number;
            workerMs?: number;
            workerRequests?: number;
          };
          writeId?: string;
        },
        null
      >;
    };
    connections: {
      disconnect: FunctionReference<
        "mutation",
        "internal",
        { accountId: Id<"accounts">; type: "chatgpt" },
        boolean
      >;
      list: FunctionReference<
        "query",
        "internal",
        { accountId: Id<"accounts"> },
        Array<{
          clientId: string;
          email?: string;
          expiresAt: number;
          hostId: string;
          scopes: Array<string>;
          type: "chatgpt";
          updatedAt: number;
        }>
      >;
      load: FunctionReference<
        "query",
        "internal",
        { accountId: Id<"accounts">; type: "chatgpt" },
        null | {
          accessToken: string;
          clientId: string;
          email?: string;
          expiresAt: number;
          hostId: string;
          refreshToken: string;
          scopes: Array<string>;
          type: "chatgpt";
          updatedAt: number;
        }
      >;
      revoke: FunctionReference<
        "action",
        "internal",
        {
          accountId: Id<"accounts">;
          ciphertext: string;
          clientId: string;
          iv: string;
          revokeUrl: string;
          tag: string;
        },
        null
      >;
      saveRefreshed: FunctionReference<
        "mutation",
        "internal",
        {
          accessToken: string;
          accountId: Id<"accounts">;
          expiresAt: number;
          loadedUpdatedAt: number;
          refreshToken: string;
          type: "chatgpt";
        },
        boolean
      >;
      set: FunctionReference<
        "mutation",
        "internal",
        {
          accessToken: string;
          accountId: Id<"accounts">;
          clientId: string;
          email?: string;
          expiresAt: number;
          hostId: string;
          refreshToken: string;
          scopes: Array<string>;
          type: "chatgpt";
        },
        {
          clientId: string;
          email?: string;
          expiresAt: number;
          hostId: string;
          scopes: Array<string>;
          type: "chatgpt";
          updatedAt: number;
        }
      >;
      status: FunctionReference<
        "query",
        "internal",
        { accountId: Id<"accounts">; type: "chatgpt" },
        null | {
          clientId: string;
          email?: string;
          expiresAt: number;
          hostId: string;
          scopes: Array<string>;
          type: "chatgpt";
          updatedAt: number;
        }
      >;
    };
    envVars: {
      list: FunctionReference<
        "query",
        "internal",
        { accountId: Id<"accounts"> },
        Array<{ name: string; updatedAt: number }>
      >;
      listPage: FunctionReference<
        "query",
        "internal",
        {
          accountId: Id<"accounts">;
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{ name: string; updatedAt: number }>;
          pageStatus?: "SplitRecommended" | "SplitRequired" | null;
          splitCursor?: string | null;
        }
      >;
      loadValues: FunctionReference<
        "query",
        "internal",
        { accountId: Id<"accounts"> },
        Record<string, string>
      >;
      remove: FunctionReference<
        "mutation",
        "internal",
        { accountId: Id<"accounts">; name: string },
        boolean
      >;
      set: FunctionReference<
        "mutation",
        "internal",
        { accountId: Id<"accounts">; name: string; value: string },
        null
      >;
    };
    hooks: {
      create: FunctionReference<
        "mutation",
        "internal",
        {
          accountId: Id<"accounts">;
          bundleStorageKey: string;
          description?: string;
          events: Array<
            | "agent.started"
            | "agent.step.finished"
            | "agent.finished"
            | "agent.failed"
            | "agent.approval.required"
            | "tool.call.started"
            | "tool.call.finished"
            | "tool.result"
            | "subagent.task.started"
            | "subagent.task.finished"
            | "channel.message.received"
            | "channel.message.sending"
          >;
          name: string;
          sha256: string;
        },
        Id<"accountHooks">
      >;
      getById: FunctionReference<
        "query",
        "internal",
        { accountId: Id<"accounts">; hookId: string },
        {
          _creationTime: number;
          _id: Id<"accountHooks">;
          accountId: Id<"accounts">;
          bundleStorageKey: string;
          createdAt: number;
          deletedAt?: number;
          description?: string;
          events: Array<
            | "agent.started"
            | "agent.step.finished"
            | "agent.finished"
            | "agent.failed"
            | "agent.approval.required"
            | "tool.call.started"
            | "tool.call.finished"
            | "tool.result"
            | "subagent.task.started"
            | "subagent.task.finished"
            | "channel.message.received"
            | "channel.message.sending"
          >;
          name: string;
          sha256: string;
          status: "active" | "deleted";
          updatedAt: number;
        } | null
      >;
      list: FunctionReference<
        "query",
        "internal",
        { accountId: Id<"accounts"> },
        Array<{
          _creationTime: number;
          _id: Id<"accountHooks">;
          accountId: Id<"accounts">;
          bundleStorageKey: string;
          createdAt: number;
          deletedAt?: number;
          description?: string;
          events: Array<
            | "agent.started"
            | "agent.step.finished"
            | "agent.finished"
            | "agent.failed"
            | "agent.approval.required"
            | "tool.call.started"
            | "tool.call.finished"
            | "tool.result"
            | "subagent.task.started"
            | "subagent.task.finished"
            | "channel.message.received"
            | "channel.message.sending"
          >;
          name: string;
          sha256: string;
          status: "active" | "deleted";
          updatedAt: number;
        }>
      >;
      listPage: FunctionReference<
        "query",
        "internal",
        {
          accountId: Id<"accounts">;
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            _creationTime: number;
            _id: Id<"accountHooks">;
            accountId: Id<"accounts">;
            bundleStorageKey: string;
            createdAt: number;
            deletedAt?: number;
            description?: string;
            events: Array<
              | "agent.started"
              | "agent.step.finished"
              | "agent.finished"
              | "agent.failed"
              | "agent.approval.required"
              | "tool.call.started"
              | "tool.call.finished"
              | "tool.result"
              | "subagent.task.started"
              | "subagent.task.finished"
              | "channel.message.received"
              | "channel.message.sending"
            >;
            name: string;
            sha256: string;
            status: "active" | "deleted";
            updatedAt: number;
          }>;
          pageStatus?: "SplitRecommended" | "SplitRequired" | null;
          splitCursor?: string | null;
        }
      >;
      remove: FunctionReference<
        "mutation",
        "internal",
        { accountId: Id<"accounts">; hookId: string },
        null
      >;
      update: FunctionReference<
        "mutation",
        "internal",
        {
          accountId: Id<"accounts">;
          bundleStorageKey?: string;
          description?: string | null;
          events?: Array<
            | "agent.started"
            | "agent.step.finished"
            | "agent.finished"
            | "agent.failed"
            | "agent.approval.required"
            | "tool.call.started"
            | "tool.call.finished"
            | "tool.result"
            | "subagent.task.started"
            | "subagent.task.finished"
            | "channel.message.received"
            | "channel.message.sending"
          >;
          hookId: string;
          name?: string;
          sha256?: string;
        },
        null
      >;
    };
    keys: {
      ensure: FunctionReference<
        "mutation",
        "internal",
        { accountId: Id<"accounts"> },
        Array<{
          kekId: string;
          keyId: string;
          retiredAt?: number;
          wrappedKey: string;
        }>
      >;
      list: FunctionReference<
        "query",
        "internal",
        { accountId: Id<"accounts"> },
        Array<{
          kekId: string;
          keyId: string;
          retiredAt?: number;
          wrappedKey: string;
        }>
      >;
      rewrapAllKeys: FunctionReference<
        "mutation",
        "internal",
        { cursor?: string | null },
        { isDone: boolean; rewrapped: number }
      >;
      rotateAccountKey: FunctionReference<
        "mutation",
        "internal",
        {
          accountId: Id<"accounts">;
          cursor?: string | null;
          table?:
            | "agents"
            | "sandboxConfigs"
            | "environmentVariables"
            | "accountEnvVars"
            | "agentRuntimeSecrets"
            | "agentDeployments"
            | "channelEndpoints"
            | "connections"
            | "auditSinks";
          target?: string;
        },
        { isDone: boolean; patched: number }
      >;
    };
    mcp: {
      agentEntries: FunctionReference<
        "query",
        "internal",
        { accountId: Id<"accounts">; serverId: Id<"mcp"> },
        Array<any>
      >;
      create: FunctionReference<
        "mutation",
        "internal",
        {
          accountId: Id<"accounts">;
          allowedTools?: Array<string>;
          bundleStorageKey?: string;
          command?: Array<string>;
          description?: string;
          disabled?: boolean;
          headers?: Record<string, string>;
          name: string;
          nodeId?: string;
          oauth?: {
            clientId: string;
            clientSecret: string;
            refreshToken: string;
            tokenUrl?: string;
          };
          projectId: Id<"projects">;
          runtime?: "auto" | "lambda";
          sandbox?: string;
          sha256?: string;
          sourceCode?: string;
          stageId: Id<"stages">;
          transport?: "http" | "hosted" | "machine";
          url?: string;
          workersCompatible?: boolean;
        },
        Id<"mcp">
      >;
      getById: FunctionReference<
        "query",
        "internal",
        { accountId: Id<"accounts">; serverId: string },
        {
          _creationTime: number;
          _id: Id<"mcp">;
          accountId: Id<"accounts">;
          allowedTools?: Array<string>;
          bundleStorageKey?: string;
          command?: Array<string>;
          createdAt: number;
          deletedAt?: number;
          description?: string;
          disabled?: boolean;
          headers?: Record<string, string>;
          name: string;
          nodeId?: string;
          oauth?: {
            clientId: string;
            clientSecret: string;
            refreshToken: string;
            tokenUrl?: string;
          };
          projectId: Id<"projects">;
          runtime?: "auto" | "lambda";
          sandbox?: string;
          sha256?: string;
          sourceCode?: string;
          stageId: Id<"stages">;
          status: "active" | "deleted";
          transport: "http" | "hosted" | "machine";
          updatedAt: number;
          url?: string;
          workersCompatible?: boolean;
        } | null
      >;
      list: FunctionReference<
        "query",
        "internal",
        { accountId: Id<"accounts"> },
        Array<{
          _creationTime: number;
          _id: Id<"mcp">;
          accountId: Id<"accounts">;
          allowedTools?: Array<string>;
          bundleStorageKey?: string;
          command?: Array<string>;
          createdAt: number;
          deletedAt?: number;
          description?: string;
          disabled?: boolean;
          headers?: Record<string, string>;
          name: string;
          nodeId?: string;
          oauth?: {
            clientId: string;
            clientSecret: string;
            refreshToken: string;
            tokenUrl?: string;
          };
          projectId: Id<"projects">;
          runtime?: "auto" | "lambda";
          sandbox?: string;
          sha256?: string;
          sourceCode?: string;
          stageId: Id<"stages">;
          status: "active" | "deleted";
          transport: "http" | "hosted" | "machine";
          updatedAt: number;
          url?: string;
          workersCompatible?: boolean;
        }>
      >;
      listForStage: FunctionReference<
        "query",
        "internal",
        { stageId: Id<"stages"> },
        Array<{
          _creationTime: number;
          _id: Id<"mcp">;
          accountId: Id<"accounts">;
          allowedTools?: Array<string>;
          bundleStorageKey?: string;
          command?: Array<string>;
          createdAt: number;
          deletedAt?: number;
          description?: string;
          disabled?: boolean;
          headers?: Record<string, string>;
          name: string;
          nodeId?: string;
          oauth?: {
            clientId: string;
            clientSecret: string;
            refreshToken: string;
            tokenUrl?: string;
          };
          projectId: Id<"projects">;
          runtime?: "auto" | "lambda";
          sandbox?: string;
          sha256?: string;
          sourceCode?: string;
          stageId: Id<"stages">;
          status: "active" | "deleted";
          transport: "http" | "hosted" | "machine";
          updatedAt: number;
          url?: string;
          workersCompatible?: boolean;
        }>
      >;
      listForStagePage: FunctionReference<
        "query",
        "internal",
        {
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
          stageId: Id<"stages">;
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            _creationTime: number;
            _id: Id<"mcp">;
            accountId: Id<"accounts">;
            allowedTools?: Array<string>;
            bundleStorageKey?: string;
            command?: Array<string>;
            createdAt: number;
            deletedAt?: number;
            description?: string;
            disabled?: boolean;
            headers?: Record<string, string>;
            name: string;
            nodeId?: string;
            oauth?: {
              clientId: string;
              clientSecret: string;
              refreshToken: string;
              tokenUrl?: string;
            };
            projectId: Id<"projects">;
            runtime?: "auto" | "lambda";
            sandbox?: string;
            sha256?: string;
            sourceCode?: string;
            stageId: Id<"stages">;
            status: "active" | "deleted";
            transport: "http" | "hosted" | "machine";
            updatedAt: number;
            url?: string;
            workersCompatible?: boolean;
          }>;
          pageStatus?: "SplitRecommended" | "SplitRequired" | null;
          splitCursor?: string | null;
        }
      >;
      remove: FunctionReference<
        "mutation",
        "internal",
        { accountId: Id<"accounts">; serverId: string },
        null
      >;
      resolveScope: FunctionReference<
        "query",
        "internal",
        { accountId: Id<"accounts">; project: string; stage: string },
        { projectId: Id<"projects">; stageId: Id<"stages"> } | null
      >;
      update: FunctionReference<
        "mutation",
        "internal",
        {
          accountId: Id<"accounts">;
          allowedTools?: Array<string>;
          bundleStorageKey?: string;
          clear?: Array<
            "allowedTools" | "command" | "description" | "headers" | "oauth"
          >;
          command?: Array<string>;
          description?: string;
          disabled?: boolean;
          headers?: Record<string, string>;
          name?: string;
          oauth?: {
            clientId: string;
            clientSecret: string;
            refreshToken: string;
            tokenUrl?: string;
          };
          runtime?: "auto" | "lambda";
          sandbox?: string;
          serverId: string;
          sha256?: string;
          sourceCode?: string;
          transport?: "http" | "hosted" | "machine";
          url?: string;
          workersCompatible?: boolean;
        },
        null
      >;
    };
    roles: {
      createInternal: FunctionReference<
        "mutation",
        "internal",
        {
          accountId: Id<"accounts">;
          name: string;
          policy: any;
          projectId?: string;
          stageId?: string;
        },
        {
          accountId: Id<"accounts">;
          createdAt: number;
          name: string;
          policy: {
            mode?: "enforce" | "audit";
            rules: Array<{
              actions: Array<string>;
              conditions?: Array<{
                attribute: string;
                operator:
                  | "equals"
                  | "notEquals"
                  | "in"
                  | "notIn"
                  | "prefix"
                  | "contains";
                value:
                  | string
                  | number
                  | boolean
                  | Array<string>
                  | Array<number>
                  | Array<boolean>;
              }>;
              effect: "allow" | "deny";
              id: string;
              resources?: {
                filePaths?: Array<string>;
                mcpIds?: Array<string>;
                resourceIds?: Array<string>;
                skillPaths?: Array<string>;
                subagentIds?: Array<string>;
                toolNames?: Array<string>;
                workspaceIds?: Array<string>;
                workspaceNames?: Array<string>;
              };
            }>;
            version: 1;
          };
          projectId?: Id<"projects">;
          roleId: string;
          stageId?: Id<"stages">;
          status: "active" | "disabled";
          updatedAt: number;
        }
      >;
      createSession: FunctionReference<
        "mutation",
        "internal",
        {
          accountId: Id<"accounts">;
          expiresAt: number;
          roleId: string;
          tokenHash: string;
        },
        null
      >;
      getByRoleId: FunctionReference<
        "query",
        "internal",
        { accountId: Id<"accounts">; roleId: string },
        {
          _creationTime: number;
          _id: Id<"accountRoles">;
          accountId: Id<"accounts">;
          createdAt: number;
          name: string;
          policy: {
            mode?: "enforce" | "audit";
            rules: Array<{
              actions: Array<string>;
              conditions?: Array<{
                attribute: string;
                operator:
                  | "equals"
                  | "notEquals"
                  | "in"
                  | "notIn"
                  | "prefix"
                  | "contains";
                value:
                  | string
                  | number
                  | boolean
                  | Array<string>
                  | Array<number>
                  | Array<boolean>;
              }>;
              effect: "allow" | "deny";
              id: string;
              resources?: {
                filePaths?: Array<string>;
                mcpIds?: Array<string>;
                resourceIds?: Array<string>;
                skillPaths?: Array<string>;
                subagentIds?: Array<string>;
                toolNames?: Array<string>;
                workspaceIds?: Array<string>;
                workspaceNames?: Array<string>;
              };
            }>;
            version: 1;
          };
          projectId?: Id<"projects">;
          roleId: string;
          stageId?: Id<"stages">;
          status: "active" | "disabled";
          updatedAt: number;
        } | null
      >;
      list: FunctionReference<
        "query",
        "internal",
        { accountId: Id<"accounts"> },
        Array<{
          _creationTime: number;
          _id: Id<"accountRoles">;
          accountId: Id<"accounts">;
          createdAt: number;
          name: string;
          policy: {
            mode?: "enforce" | "audit";
            rules: Array<{
              actions: Array<string>;
              conditions?: Array<{
                attribute: string;
                operator:
                  | "equals"
                  | "notEquals"
                  | "in"
                  | "notIn"
                  | "prefix"
                  | "contains";
                value:
                  | string
                  | number
                  | boolean
                  | Array<string>
                  | Array<number>
                  | Array<boolean>;
              }>;
              effect: "allow" | "deny";
              id: string;
              resources?: {
                filePaths?: Array<string>;
                mcpIds?: Array<string>;
                resourceIds?: Array<string>;
                skillPaths?: Array<string>;
                subagentIds?: Array<string>;
                toolNames?: Array<string>;
                workspaceIds?: Array<string>;
                workspaceNames?: Array<string>;
              };
            }>;
            version: 1;
          };
          projectId?: Id<"projects">;
          roleId: string;
          stageId?: Id<"stages">;
          status: "active" | "disabled";
          updatedAt: number;
        }>
      >;
      listPage: FunctionReference<
        "query",
        "internal",
        {
          accountId: Id<"accounts">;
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            _creationTime: number;
            _id: Id<"accountRoles">;
            accountId: Id<"accounts">;
            createdAt: number;
            name: string;
            policy: {
              mode?: "enforce" | "audit";
              rules: Array<{
                actions: Array<string>;
                conditions?: Array<{
                  attribute: string;
                  operator:
                    | "equals"
                    | "notEquals"
                    | "in"
                    | "notIn"
                    | "prefix"
                    | "contains";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | Array<boolean>;
                }>;
                effect: "allow" | "deny";
                id: string;
                resources?: {
                  filePaths?: Array<string>;
                  mcpIds?: Array<string>;
                  resourceIds?: Array<string>;
                  skillPaths?: Array<string>;
                  subagentIds?: Array<string>;
                  toolNames?: Array<string>;
                  workspaceIds?: Array<string>;
                  workspaceNames?: Array<string>;
                };
              }>;
              version: 1;
            };
            projectId?: Id<"projects">;
            roleId: string;
            stageId?: Id<"stages">;
            status: "active" | "disabled";
            updatedAt: number;
          }>;
          pageStatus?: "SplitRecommended" | "SplitRequired" | null;
          splitCursor?: string | null;
        }
      >;
      pruneExpiredSessions: FunctionReference<
        "mutation",
        "internal",
        { batchSize?: number; now?: number },
        { sessionsDeleted: number }
      >;
      refsOutsidePin: FunctionReference<
        "query",
        "internal",
        {
          accountId: Id<"accounts">;
          pin: { projectId: string; stageId: string };
          refs: Array<{
            id: string;
            type:
              | "agents"
              | "channels"
              | "crons"
              | "mcp"
              | "policies"
              | "sandboxes"
              | "workspaces";
          }>;
        },
        Array<{
          id: string;
          type:
            | "agents"
            | "channels"
            | "crons"
            | "mcp"
            | "policies"
            | "sandboxes"
            | "workspaces";
        }>
      >;
      removeInternal: FunctionReference<
        "mutation",
        "internal",
        { accountId: Id<"accounts">; roleId: string },
        {
          _creationTime: number;
          _id: Id<"accountRoles">;
          accountId: Id<"accounts">;
          createdAt: number;
          name: string;
          policy: {
            mode?: "enforce" | "audit";
            rules: Array<{
              actions: Array<string>;
              conditions?: Array<{
                attribute: string;
                operator:
                  | "equals"
                  | "notEquals"
                  | "in"
                  | "notIn"
                  | "prefix"
                  | "contains";
                value:
                  | string
                  | number
                  | boolean
                  | Array<string>
                  | Array<number>
                  | Array<boolean>;
              }>;
              effect: "allow" | "deny";
              id: string;
              resources?: {
                filePaths?: Array<string>;
                mcpIds?: Array<string>;
                resourceIds?: Array<string>;
                skillPaths?: Array<string>;
                subagentIds?: Array<string>;
                toolNames?: Array<string>;
                workspaceIds?: Array<string>;
                workspaceNames?: Array<string>;
              };
            }>;
            version: 1;
          };
          projectId?: Id<"projects">;
          roleId: string;
          stageId?: Id<"stages">;
          status: "active" | "disabled";
          updatedAt: number;
        } | null
      >;
      resolveSession: FunctionReference<
        "query",
        "internal",
        { tokenHash: string },
        {
          accountId: Id<"accounts">;
          policy: {
            mode?: "enforce" | "audit";
            rules: Array<{
              actions: Array<string>;
              conditions?: Array<{
                attribute: string;
                operator:
                  | "equals"
                  | "notEquals"
                  | "in"
                  | "notIn"
                  | "prefix"
                  | "contains";
                value:
                  | string
                  | number
                  | boolean
                  | Array<string>
                  | Array<number>
                  | Array<boolean>;
              }>;
              effect: "allow" | "deny";
              id: string;
              resources?: {
                filePaths?: Array<string>;
                mcpIds?: Array<string>;
                resourceIds?: Array<string>;
                skillPaths?: Array<string>;
                subagentIds?: Array<string>;
                toolNames?: Array<string>;
                workspaceIds?: Array<string>;
                workspaceNames?: Array<string>;
              };
            }>;
            version: 1;
          };
          projectId?: Id<"projects">;
          roleId: string;
          stageId?: Id<"stages">;
        } | null
      >;
      resourceScope: FunctionReference<
        "query",
        "internal",
        {
          accountId: Id<"accounts">;
          id: string;
          type:
            | "agents"
            | "channels"
            | "crons"
            | "mcp"
            | "policies"
            | "sandboxes"
            | "workspaces";
        },
        { projectId: Id<"projects">; stageId: Id<"stages"> } | null
      >;
      updateInternal: FunctionReference<
        "mutation",
        "internal",
        {
          accountId: Id<"accounts">;
          name?: string;
          policy?: any;
          roleId: string;
          status?: "active" | "disabled";
        },
        {
          _creationTime: number;
          _id: Id<"accountRoles">;
          accountId: Id<"accounts">;
          createdAt: number;
          name: string;
          policy: {
            mode?: "enforce" | "audit";
            rules: Array<{
              actions: Array<string>;
              conditions?: Array<{
                attribute: string;
                operator:
                  | "equals"
                  | "notEquals"
                  | "in"
                  | "notIn"
                  | "prefix"
                  | "contains";
                value:
                  | string
                  | number
                  | boolean
                  | Array<string>
                  | Array<number>
                  | Array<boolean>;
              }>;
              effect: "allow" | "deny";
              id: string;
              resources?: {
                filePaths?: Array<string>;
                mcpIds?: Array<string>;
                resourceIds?: Array<string>;
                skillPaths?: Array<string>;
                subagentIds?: Array<string>;
                toolNames?: Array<string>;
                workspaceIds?: Array<string>;
                workspaceNames?: Array<string>;
              };
            }>;
            version: 1;
          };
          projectId?: Id<"projects">;
          roleId: string;
          stageId?: Id<"stages">;
          status: "active" | "disabled";
          updatedAt: number;
        } | null
      >;
    };
    storageTrust: {
      externalId: FunctionReference<
        "mutation",
        "internal",
        { accountId: string },
        string
      >;
      get: FunctionReference<
        "mutation",
        "internal",
        { accountId: Id<"accounts"> },
        { externalId: string; principalArn?: string; trustPolicy?: string }
      >;
    };
    uploads: {
      grant: FunctionReference<
        "mutation",
        "internal",
        { accountId: Id<"accounts">; kind: "mcp" | "workspace" },
        { uploadUrl: string } | { retryAt: number }
      >;
      pruneOrphans: FunctionReference<
        "mutation",
        "internal",
        { cursor?: string | null },
        { deleted: number; isDone: boolean }
      >;
    };
  };
  agent: {
    agents: {
      create: FunctionReference<
        "mutation",
        "internal",
        {
          accountId: Id<"accounts">;
          description?: string;
          encryptedConfig?: string;
          encryptedSourceConfig?: string;
          encryptionIv?: string;
          encryptionTag?: string;
          name: string;
          sourceEncryptionIv?: string;
          sourceEncryptionTag?: string;
        },
        Id<"agents">
      >;
      getById: FunctionReference<
        "query",
        "internal",
        { accountId: Id<"accounts">; agentId: string },
        {
          _creationTime: number;
          _id: Id<"agents">;
          accountId: Id<"accounts">;
          createdAt: number;
          description?: string;
          encryptedConfig?: string;
          encryptedSourceConfig?: string;
          encryptionIv?: string;
          encryptionTag?: string;
          name: string;
          requireUserToken?: boolean;
          sourceEncryptionIv?: string;
          sourceEncryptionTag?: string;
          updatedAt: number;
        } | null
      >;
      getByName: FunctionReference<
        "query",
        "internal",
        { accountId: Id<"accounts">; name: string },
        {
          _creationTime: number;
          _id: Id<"agents">;
          accountId: Id<"accounts">;
          createdAt: number;
          description?: string;
          encryptedConfig?: string;
          encryptedSourceConfig?: string;
          encryptionIv?: string;
          encryptionTag?: string;
          name: string;
          requireUserToken?: boolean;
          sourceEncryptionIv?: string;
          sourceEncryptionTag?: string;
          updatedAt: number;
        } | null
      >;
      list: FunctionReference<
        "query",
        "internal",
        { accountId: Id<"accounts"> },
        Array<{
          _creationTime: number;
          _id: Id<"agents">;
          accountId: Id<"accounts">;
          createdAt: number;
          description?: string;
          encryptedConfig?: string;
          encryptedSourceConfig?: string;
          encryptionIv?: string;
          encryptionTag?: string;
          name: string;
          requireUserToken?: boolean;
          sourceEncryptionIv?: string;
          sourceEncryptionTag?: string;
          updatedAt: number;
        }>
      >;
      listForeignAgentLinks: FunctionReference<
        "query",
        "internal",
        {
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            agentAccountId: Id<"accounts">;
            agentId: Id<"agents">;
            configId: Id<"agentConfigs">;
            configName: string;
            projectAccountId: Id<"accounts"> | null;
            projectId: Id<"projects">;
            stageId: Id<"stages">;
          }>;
          pageStatus?: "SplitRecommended" | "SplitRequired" | null;
          splitCursor?: string | null;
        }
      >;
      listForEndpoint: FunctionReference<
        "query",
        "internal",
        { accountId: Id<"accounts">; endpointId: string },
        Array<{
          _creationTime: number;
          _id: Id<"agents">;
          accountId: Id<"accounts">;
          createdAt: number;
          description?: string;
          encryptedConfig?: string;
          encryptedSourceConfig?: string;
          encryptionIv?: string;
          encryptionTag?: string;
          name: string;
          requireUserToken?: boolean;
          sourceEncryptionIv?: string;
          sourceEncryptionTag?: string;
          updatedAt: number;
        }>
      >;
      listForProduction: FunctionReference<
        "query",
        "internal",
        { accountId: Id<"accounts"> },
        Array<{
          _creationTime: number;
          _id: Id<"agents">;
          accountId: Id<"accounts">;
          createdAt: number;
          description?: string;
          encryptedConfig?: string;
          encryptedSourceConfig?: string;
          encryptionIv?: string;
          encryptionTag?: string;
          name: string;
          requireUserToken?: boolean;
          sourceEncryptionIv?: string;
          sourceEncryptionTag?: string;
          updatedAt: number;
        }>
      >;
      listForStage: FunctionReference<
        "query",
        "internal",
        {
          accountId: Id<"accounts">;
          projectId: Id<"projects">;
          stageId: Id<"stages">;
        },
        Array<{
          _creationTime: number;
          _id: Id<"agents">;
          accountId: Id<"accounts">;
          createdAt: number;
          description?: string;
          encryptedConfig?: string;
          encryptedSourceConfig?: string;
          encryptionIv?: string;
          encryptionTag?: string;
          name: string;
          requireUserToken?: boolean;
          sourceEncryptionIv?: string;
          sourceEncryptionTag?: string;
          updatedAt: number;
        }>
      >;
      listPage: FunctionReference<
        "query",
        "internal",
        {
          accountId: Id<"accounts">;
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            _creationTime: number;
            _id: Id<"agents">;
            accountId: Id<"accounts">;
            createdAt: number;
            description?: string;
            encryptedConfig?: string;
            encryptedSourceConfig?: string;
            encryptionIv?: string;
            encryptionTag?: string;
            name: string;
            requireUserToken?: boolean;
            sourceEncryptionIv?: string;
            sourceEncryptionTag?: string;
            updatedAt: number;
          }>;
          pageStatus?: "SplitRecommended" | "SplitRequired" | null;
          splitCursor?: string | null;
        }
      >;
      remove: FunctionReference<
        "mutation",
        "internal",
        { accountId: Id<"accounts">; agentId: string },
        null
      >;
      update: FunctionReference<
        "mutation",
        "internal",
        {
          accountId: Id<"accounts">;
          agentId: string;
          clearSourceConfig?: boolean;
          description?: string;
          encryptedConfig?: string;
          encryptedSourceConfig?: string;
          encryptionIv?: string;
          encryptionTag?: string;
          name?: string;
          sourceEncryptionIv?: string;
          sourceEncryptionTag?: string;
        },
        null
      >;
    };
    crons: {
      completeRun: FunctionReference<
        "mutation",
        "internal",
        {
          accountId: Id<"accounts">;
          cronId: Id<"crons">;
          result: any;
          runId: Id<"cronRuns">;
        },
        null
      >;
      create: FunctionReference<
        "mutation",
        "internal",
        {
          accountId: Id<"accounts">;
          createdBy?: Id<"users">;
          input: Record<string, any>;
        },
        any
      >;
      createRun: FunctionReference<
        "mutation",
        "internal",
        {
          accountId: Id<"accounts">;
          conversationKey: string;
          cronId: Id<"crons">;
          eventId: string;
          firedAt: number;
        },
        Id<"cronRuns">
      >;
      dispatch: FunctionReference<
        "action",
        "internal",
        { accountId: Id<"accounts">; cronId: Id<"crons"> },
        null
      >;
      failRun: FunctionReference<
        "mutation",
        "internal",
        {
          accountId: Id<"accounts">;
          cronId: Id<"crons">;
          error: string;
          runId: Id<"cronRuns">;
        },
        null
      >;
      getById: FunctionReference<
        "query",
        "internal",
        { accountId: Id<"accounts">; cronId: Id<"crons"> },
        {
          _creationTime: number;
          _id: Id<"crons">;
          accountId: Id<"accounts">;
          agentId: Id<"agents">;
          conversationKey?: string;
          createdAt: number;
          createdBy?: Id<"users">;
          description?: string;
          events: Array<any>;
          lastError?: string;
          lastInvokedAt?: number;
          lastRunId?: Id<"cronRuns">;
          lastStatus?: "started" | "completed" | "failed";
          name: string;
          scheduleExpression: string;
          scheduledRunId?: Id<"_scheduled_functions">;
          status: "active" | "paused";
          timezone?: string;
          updatedAt: number;
        } | null
      >;
      isLive: FunctionReference<
        "query",
        "internal",
        { accountId: Id<"accounts">; cronId: Id<"crons"> },
        boolean
      >;
      list: FunctionReference<
        "query",
        "internal",
        { accountId: Id<"accounts">; agentId?: Id<"agents"> },
        Array<{
          _creationTime: number;
          _id: Id<"crons">;
          accountId: Id<"accounts">;
          agentId: Id<"agents">;
          conversationKey?: string;
          createdAt: number;
          createdBy?: Id<"users">;
          description?: string;
          events: Array<any>;
          lastError?: string;
          lastInvokedAt?: number;
          lastRunId?: Id<"cronRuns">;
          lastStatus?: "started" | "completed" | "failed";
          name: string;
          scheduleExpression: string;
          scheduledRunId?: Id<"_scheduled_functions">;
          status: "active" | "paused";
          timezone?: string;
          updatedAt: number;
        }>
      >;
      listPage: FunctionReference<
        "query",
        "internal",
        {
          accountId: Id<"accounts">;
          agentId?: Id<"agents">;
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            _creationTime: number;
            _id: Id<"crons">;
            accountId: Id<"accounts">;
            agentId: Id<"agents">;
            conversationKey?: string;
            createdAt: number;
            createdBy?: Id<"users">;
            description?: string;
            events: Array<any>;
            lastError?: string;
            lastInvokedAt?: number;
            lastRunId?: Id<"cronRuns">;
            lastStatus?: "started" | "completed" | "failed";
            name: string;
            scheduleExpression: string;
            scheduledRunId?: Id<"_scheduled_functions">;
            status: "active" | "paused";
            timezone?: string;
            updatedAt: number;
          }>;
          pageStatus?: "SplitRecommended" | "SplitRequired" | null;
          splitCursor?: string | null;
        }
      >;
      listRuns: FunctionReference<
        "query",
        "internal",
        { accountId: Id<"accounts">; cronId: Id<"crons"> },
        Array<{
          _creationTime: number;
          _id: Id<"cronRuns">;
          accountId: Id<"accounts">;
          completedAt?: number;
          conversationKey: string;
          cronId: Id<"crons">;
          error?: string;
          eventId: string;
          result?: any;
          startedAt: number;
          status: "started" | "completed" | "failed";
        }>
      >;
      listRunsPage: FunctionReference<
        "query",
        "internal",
        {
          accountId: Id<"accounts">;
          cronId: Id<"crons">;
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            _creationTime: number;
            _id: Id<"cronRuns">;
            accountId: Id<"accounts">;
            completedAt?: number;
            conversationKey: string;
            cronId: Id<"crons">;
            error?: string;
            eventId: string;
            result?: any;
            startedAt: number;
            status: "started" | "completed" | "failed";
          }>;
          pageStatus?: "SplitRecommended" | "SplitRequired" | null;
          splitCursor?: string | null;
        }
      >;
      pruneExpiredRuns: FunctionReference<"mutation", "internal", {}, number>;
      recordFailedFire: FunctionReference<
        "mutation",
        "internal",
        {
          accountId: Id<"accounts">;
          cronId: Id<"crons">;
          error: string;
          firedAt: number;
        },
        null
      >;
      remove: FunctionReference<
        "mutation",
        "internal",
        { accountId: Id<"accounts">; cronId: string },
        boolean
      >;
      removeRunsCascade: FunctionReference<
        "mutation",
        "internal",
        { accountId: Id<"accounts">; cronId: Id<"crons"> },
        null
      >;
      update: FunctionReference<
        "mutation",
        "internal",
        {
          accountId: Id<"accounts">;
          cronId: string;
          patch: Record<string, any>;
          pin?: { projectId: string; stageId: string };
        },
        any
      >;
    };
    deployments: {
      getByAgentId: FunctionReference<
        "query",
        "internal",
        { accountId: Id<"accounts">; agentId: string },
        {
          accountId: Id<"accounts">;
          endpointId: string;
          projectId: Id<"projects">;
          projectSlug: string;
          stageId: Id<"stages">;
          stageSlug: string;
        } | null
      >;
      getByApiKeyHash: FunctionReference<
        "query",
        "internal",
        { apiKeyHash: string },
        {
          account: {
            _creationTime: number;
            _id: Id<"accounts">;
            auditRetentionDays?: number;
            createdAt: number;
            description?: string;
            orgId: string;
            secretHash: string;
            secretHint?: string;
            secretRotatedAt?: number;
            secretRotatedBy?: Id<"users">;
            status: "active" | "disabled";
            storageExternalId?: string;
            updatedAt: number;
            username: string;
          };
          accountId: Id<"accounts">;
          endpointId: string;
          projectId: Id<"projects">;
          projectSlug: string;
          stageId: Id<"stages">;
          stageSlug: string;
          userTokenSecret?: { ciphertext: string; iv: string; tag: string };
        } | null
      >;
      touchLastUsed: FunctionReference<
        "mutation",
        "internal",
        { apiKeyHash: string; usedAt: number },
        null
      >;
    };
    policies: {
      createInternal: FunctionReference<
        "mutation",
        "internal",
        {
          accountId: Id<"accounts">;
          description?: string;
          document: any;
          managedBy?: "cli" | "dashboard";
          name: string;
          projectId?: Id<"projects">;
          stageId?: Id<"stages">;
        },
        Id<"agentPolicies">
      >;
      getById: FunctionReference<
        "query",
        "internal",
        { accountId: Id<"accounts">; policyId: string },
        {
          _creationTime: number;
          _id: Id<"agentPolicies">;
          accountId: Id<"accounts">;
          createdAt: number;
          createdBy?: Id<"users">;
          deletedAt?: number;
          description?: string;
          document: {
            mode?: "enforce" | "audit";
            rules: Array<{
              actions: Array<string>;
              conditions?: Array<{
                attribute: string;
                operator:
                  | "equals"
                  | "notEquals"
                  | "in"
                  | "notIn"
                  | "prefix"
                  | "contains";
                value:
                  | string
                  | number
                  | boolean
                  | Array<string>
                  | Array<number>
                  | Array<boolean>;
              }>;
              effect: "allow" | "deny";
              id: string;
              resources?: {
                filePaths?: Array<string>;
                mcpIds?: Array<string>;
                resourceIds?: Array<string>;
                skillPaths?: Array<string>;
                subagentIds?: Array<string>;
                toolNames?: Array<string>;
                workspaceIds?: Array<string>;
                workspaceNames?: Array<string>;
              };
            }>;
            version: 1;
          };
          managedBy?: "cli" | "dashboard" | "api";
          name: string;
          projectId?: Id<"projects">;
          stageId?: Id<"stages">;
          status: "active" | "deleted";
          updatedAt: number;
        } | null
      >;
      list: FunctionReference<
        "query",
        "internal",
        { accountId: Id<"accounts"> },
        Array<{
          _creationTime: number;
          _id: Id<"agentPolicies">;
          accountId: Id<"accounts">;
          createdAt: number;
          createdBy?: Id<"users">;
          deletedAt?: number;
          description?: string;
          document: {
            mode?: "enforce" | "audit";
            rules: Array<{
              actions: Array<string>;
              conditions?: Array<{
                attribute: string;
                operator:
                  | "equals"
                  | "notEquals"
                  | "in"
                  | "notIn"
                  | "prefix"
                  | "contains";
                value:
                  | string
                  | number
                  | boolean
                  | Array<string>
                  | Array<number>
                  | Array<boolean>;
              }>;
              effect: "allow" | "deny";
              id: string;
              resources?: {
                filePaths?: Array<string>;
                mcpIds?: Array<string>;
                resourceIds?: Array<string>;
                skillPaths?: Array<string>;
                subagentIds?: Array<string>;
                toolNames?: Array<string>;
                workspaceIds?: Array<string>;
                workspaceNames?: Array<string>;
              };
            }>;
            version: 1;
          };
          managedBy?: "cli" | "dashboard" | "api";
          name: string;
          projectId?: Id<"projects">;
          stageId?: Id<"stages">;
          status: "active" | "deleted";
          updatedAt: number;
        }>
      >;
      listPage: FunctionReference<
        "query",
        "internal",
        {
          accountId: Id<"accounts">;
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            _creationTime: number;
            _id: Id<"agentPolicies">;
            accountId: Id<"accounts">;
            createdAt: number;
            createdBy?: Id<"users">;
            deletedAt?: number;
            description?: string;
            document: {
              mode?: "enforce" | "audit";
              rules: Array<{
                actions: Array<string>;
                conditions?: Array<{
                  attribute: string;
                  operator:
                    | "equals"
                    | "notEquals"
                    | "in"
                    | "notIn"
                    | "prefix"
                    | "contains";
                  value:
                    | string
                    | number
                    | boolean
                    | Array<string>
                    | Array<number>
                    | Array<boolean>;
                }>;
                effect: "allow" | "deny";
                id: string;
                resources?: {
                  filePaths?: Array<string>;
                  mcpIds?: Array<string>;
                  resourceIds?: Array<string>;
                  skillPaths?: Array<string>;
                  subagentIds?: Array<string>;
                  toolNames?: Array<string>;
                  workspaceIds?: Array<string>;
                  workspaceNames?: Array<string>;
                };
              }>;
              version: 1;
            };
            managedBy?: "cli" | "dashboard" | "api";
            name: string;
            projectId?: Id<"projects">;
            stageId?: Id<"stages">;
            status: "active" | "deleted";
            updatedAt: number;
          }>;
          pageStatus?: "SplitRecommended" | "SplitRequired" | null;
          splitCursor?: string | null;
        }
      >;
      removeInternal: FunctionReference<
        "mutation",
        "internal",
        { accountId: Id<"accounts">; policyId: string },
        null
      >;
      updateInternal: FunctionReference<
        "mutation",
        "internal",
        {
          accountId: Id<"accounts">;
          description?: string | null;
          document?: any;
          name?: string;
          policyId: string;
          status?: "active" | "deleted";
        },
        null
      >;
    };
  };
  audit: {
    ledger: {
      head: FunctionReference<
        "query",
        "internal",
        { accountId: Id<"accounts"> },
        { hash: string; seq: number } | null
      >;
      list: FunctionReference<
        "query",
        "internal",
        { accountId: Id<"accounts">; limit: number; since: number },
        Array<{
          _creationTime: number;
          _id: Id<"auditEvents">;
          accountId: Id<"accounts">;
          action: string;
          actor: {
            agentId?: string;
            chain?: Array<
              | { channel?: string; id: string; kind: "user"; name?: string }
              | { keyKind: "account" | "deployment" | "cron"; kind: "api" }
              | { agentId: string; kind: "agent" }
            >;
            email?: string;
            id?: string;
            kind:
              | "dashboardUser"
              | "apiAccountSecret"
              | "accountApiKey"
              | "admin"
              | "service"
              | "cli"
              | "deployKey"
              | "role"
              | "agent";
            name?: string;
          };
          at: number;
          detailsJson?: string;
          hash: string;
          prevHash: string;
          projectId?: Id<"projects">;
          resource: {
            id?: string;
            kind:
              | "account"
              | "accountApiKey"
              | "agent"
              | "skill"
              | "hook"
              | "mcp"
              | "workspace"
              | "workspaceFile"
              | "cron"
              | "sandbox"
              | "policy"
              | "role"
              | "channel"
              | "environmentVariable"
              | "deployment"
              | "webhook"
              | "manifest"
              | "run"
              | "tool"
              | "auditSink"
              | "unknown";
            name?: string;
          };
          seq: number;
          stageId?: Id<"stages">;
          summary: string;
          traceId?: string;
        }>
      >;
      pruneExpired: FunctionReference<
        "mutation",
        "internal",
        { cursor?: string; now?: number },
        number
      >;
      record: FunctionReference<
        "mutation",
        "internal",
        {
          accountId: Id<"accounts">;
          action: string;
          actor: {
            agentId?: string;
            chain?: Array<
              | { channel?: string; id: string; kind: "user"; name?: string }
              | { keyKind: "account" | "deployment" | "cron"; kind: "api" }
              | { agentId: string; kind: "agent" }
            >;
            email?: string;
            id?: string;
            kind:
              | "dashboardUser"
              | "apiAccountSecret"
              | "accountApiKey"
              | "admin"
              | "service"
              | "cli"
              | "deployKey"
              | "role"
              | "agent";
            name?: string;
          };
          detailsJson?: string;
          projectId?: Id<"projects">;
          resource: {
            id?: string;
            kind:
              | "account"
              | "accountApiKey"
              | "agent"
              | "skill"
              | "hook"
              | "mcp"
              | "workspace"
              | "workspaceFile"
              | "cron"
              | "sandbox"
              | "policy"
              | "role"
              | "channel"
              | "environmentVariable"
              | "deployment"
              | "webhook"
              | "manifest"
              | "run"
              | "tool"
              | "auditSink"
              | "unknown";
            name?: string;
          };
          stageId?: Id<"stages">;
          summary: string;
          traceId?: string;
        },
        Id<"auditEvents">
      >;
      verifyChain: FunctionReference<
        "query",
        "internal",
        { accountId: Id<"accounts">; fromSeq?: number; toSeq?: number },
        {
          brokenAtSeq?: number;
          checkedFrom?: number;
          checkedTo?: number;
          ok: boolean;
        }
      >;
    };
    sinks: {
      exportDue: FunctionReference<"action", "internal", {}, null>;
      get: FunctionReference<
        "query",
        "internal",
        { accountId: Id<"accounts"> },
        {
          _creationTime: number;
          _id: Id<"auditSinks">;
          accountId: Id<"accounts">;
          encryptedSecret: string;
          exportedSeq: number;
          kind: "webhook";
          lastError?: string;
          secretIv: string;
          secretTag: string;
          updatedAt: number;
          url: string;
        } | null
      >;
      listDue: FunctionReference<
        "query",
        "internal",
        { cursor: string | null },
        {
          cursor: string | null;
          due: Array<{
            _creationTime: number;
            _id: Id<"auditSinks">;
            accountId: Id<"accounts">;
            encryptedSecret: string;
            exportedSeq: number;
            kind: "webhook";
            lastError?: string;
            secretIv: string;
            secretTag: string;
            updatedAt: number;
            url: string;
          }>;
        }
      >;
      markError: FunctionReference<
        "mutation",
        "internal",
        { error: string; sinkId: Id<"auditSinks"> },
        null
      >;
      markExported: FunctionReference<
        "mutation",
        "internal",
        { exportedSeq: number; sinkId: Id<"auditSinks"> },
        null
      >;
      put: FunctionReference<
        "mutation",
        "internal",
        {
          accountId: Id<"accounts">;
          encryptedSecret: string;
          secretIv: string;
          secretTag: string;
          url: string;
        },
        {
          _creationTime: number;
          _id: Id<"auditSinks">;
          accountId: Id<"accounts">;
          encryptedSecret: string;
          exportedSeq: number;
          kind: "webhook";
          lastError?: string;
          secretIv: string;
          secretTag: string;
          updatedAt: number;
          url: string;
        }
      >;
      remove: FunctionReference<
        "mutation",
        "internal",
        { accountId: Id<"accounts"> },
        boolean
      >;
    };
  };
  auth: {
    authKitAction: FunctionReference<
      "mutation",
      "internal",
      { action: Record<string, any> },
      Record<string, any>
    >;
    authKitEvent: FunctionReference<
      "mutation",
      "internal",
      { data: Record<string, any>; event: string },
      null
    >;
  };
  aws: {
    bundles: {
      putHookBundle: FunctionReference<
        "action",
        "internal",
        {
          accountId: Id<"accounts">;
          sha256: string;
          storageId: Id<"_storage">;
        },
        string
      >;
      putMcpBundle: FunctionReference<
        "action",
        "internal",
        {
          accountId: Id<"accounts">;
          sha256: string;
          storageId: Id<"_storage">;
        },
        { key: string; workersCompatible: boolean }
      >;
    };
    skills: {
      createSkill: FunctionReference<
        "action",
        "internal",
        { accountId: Id<"accounts">; expectedName?: string; input: any },
        {
          description: string;
          files: Array<{ path: string; size?: number }>;
          name: string;
          path: string;
        }
      >;
      get: FunctionReference<
        "action",
        "internal",
        { accountId: Id<"accounts">; skillName: string },
        {
          description: string;
          files: Array<{ path: string; size?: number }>;
          name: string;
          path: string;
        } | null
      >;
      list: FunctionReference<
        "action",
        "internal",
        { accountId: Id<"accounts"> },
        Array<{ description: string; name: string; path: string }>
      >;
      remove: FunctionReference<
        "action",
        "internal",
        { accountId: Id<"accounts">; skillName: string },
        boolean
      >;
      validateSkills: FunctionReference<
        "action",
        "internal",
        { skills: Array<{ files: any; name: string }> },
        null
      >;
    };
    storageMeter: {
      snapshotAccount: FunctionReference<
        "action",
        "internal",
        { accountId: Id<"accounts">; snapshotAt: number },
        null
      >;
      snapshotAll: FunctionReference<"action", "internal", {}, null>;
    };
    workspaceFiles: {
      downloadUrl: FunctionReference<
        "action",
        "internal",
        {
          accountId: Id<"accounts">;
          path: string;
          storage?: {
            auth?:
              | { type: "managed" }
              | { accessKeyId: string; secretAccessKey: string; type: "r2" }
              | { roleArn: string; type: "assumeRole" };
            bucket?: string;
            endpoint?: string;
            prefix?: string;
            provider: "s3";
            region?: string;
          };
          workspaceId: Id<"workspaceConfigs">;
        },
        string
      >;
      list: FunctionReference<
        "action",
        "internal",
        {
          accountId: Id<"accounts">;
          storage?: {
            auth?:
              | { type: "managed" }
              | { accessKeyId: string; secretAccessKey: string; type: "r2" }
              | { roleArn: string; type: "assumeRole" };
            bucket?: string;
            endpoint?: string;
            prefix?: string;
            provider: "s3";
            region?: string;
          };
          workspaceId: Id<"workspaceConfigs">;
        },
        Array<{
          isFolder: boolean;
          name: string;
          path: string;
          sizeBytes?: number;
          updatedAt?: string;
        }>
      >;
      purge: FunctionReference<
        "action",
        "internal",
        {
          accountId: Id<"accounts">;
          storage?: {
            auth?:
              | { type: "managed" }
              | { accessKeyId: string; secretAccessKey: string; type: "r2" }
              | { roleArn: string; type: "assumeRole" };
            bucket?: string;
            endpoint?: string;
            prefix?: string;
            provider: "s3";
            region?: string;
          };
          workspaceId: Id<"workspaceConfigs">;
        },
        number
      >;
      removePath: FunctionReference<
        "action",
        "internal",
        {
          accountId: Id<"accounts">;
          path: string;
          storage?: {
            auth?:
              | { type: "managed" }
              | { accessKeyId: string; secretAccessKey: string; type: "r2" }
              | { roleArn: string; type: "assumeRole" };
            bucket?: string;
            endpoint?: string;
            prefix?: string;
            provider: "s3";
            region?: string;
          };
          workspaceId: Id<"workspaceConfigs">;
        },
        number
      >;
      renamePath: FunctionReference<
        "action",
        "internal",
        {
          accountId: Id<"accounts">;
          newPath: string;
          path: string;
          storage?: {
            auth?:
              | { type: "managed" }
              | { accessKeyId: string; secretAccessKey: string; type: "r2" }
              | { roleArn: string; type: "assumeRole" };
            bucket?: string;
            endpoint?: string;
            prefix?: string;
            provider: "s3";
            region?: string;
          };
          workspaceId: Id<"workspaceConfigs">;
        },
        number
      >;
      upload: FunctionReference<
        "action",
        "internal",
        {
          accountId: Id<"accounts">;
          contentBase64: string;
          contentType?: string;
          path: string;
          storage?: {
            auth?:
              | { type: "managed" }
              | { accessKeyId: string; secretAccessKey: string; type: "r2" }
              | { roleArn: string; type: "assumeRole" };
            bucket?: string;
            endpoint?: string;
            prefix?: string;
            provider: "s3";
            region?: string;
          };
          workspaceId: Id<"workspaceConfigs">;
        },
        {
          isFolder: boolean;
          name: string;
          path: string;
          sizeBytes?: number;
          updatedAt?: string;
        }
      >;
    };
  };
  channel: {
    connections: {
      listConnections: FunctionReference<
        "query",
        "internal",
        { channel: string },
        Array<{
          agentId: string;
          agentName: string;
          apiUrl?: string;
          botToken: string;
          webhookPath: string;
        }>
      >;
    };
    endpointReconcile: {
      reconcile: FunctionReference<
        "mutation",
        "internal",
        { cursor?: string | null; source?: "deployments" | "stored" },
        number
      >;
      reconcileAccount: FunctionReference<
        "mutation",
        "internal",
        { accountId: Id<"accounts"> },
        null
      >;
    };
    records: {
      create: FunctionReference<
        "mutation",
        "internal",
        {
          accountId: Id<"accounts">;
          config: any;
          description?: string;
          externalId: string;
          name: string;
          platform: string;
          workspaceRef?: string;
        },
        Id<"channelRecords">
      >;
      getByExternalId: FunctionReference<
        "query",
        "internal",
        { accountId: Id<"accounts">; externalId: string; platform: string },
        {
          _creationTime: number;
          _id: Id<"channelRecords">;
          accountId: Id<"accounts">;
          config: any;
          createdAt: number;
          createdBy?: Id<"users">;
          deletedAt?: number;
          description?: string;
          externalId: string;
          managedBy?: "cli" | "dashboard" | "api";
          name: string;
          platform: string;
          projectId?: Id<"projects">;
          stageId?: Id<"stages">;
          status: "active" | "deleted";
          updatedAt: number;
          workspaceRef?: string;
        } | null
      >;
      getById: FunctionReference<
        "query",
        "internal",
        { accountId: Id<"accounts">; channelRecordId: string },
        {
          _creationTime: number;
          _id: Id<"channelRecords">;
          accountId: Id<"accounts">;
          config: any;
          createdAt: number;
          createdBy?: Id<"users">;
          deletedAt?: number;
          description?: string;
          externalId: string;
          managedBy?: "cli" | "dashboard" | "api";
          name: string;
          platform: string;
          projectId?: Id<"projects">;
          stageId?: Id<"stages">;
          status: "active" | "deleted";
          updatedAt: number;
          workspaceRef?: string;
        } | null
      >;
      list: FunctionReference<
        "query",
        "internal",
        { accountId: Id<"accounts"> },
        Array<{
          _creationTime: number;
          _id: Id<"channelRecords">;
          accountId: Id<"accounts">;
          config: any;
          createdAt: number;
          createdBy?: Id<"users">;
          deletedAt?: number;
          description?: string;
          externalId: string;
          managedBy?: "cli" | "dashboard" | "api";
          name: string;
          platform: string;
          projectId?: Id<"projects">;
          stageId?: Id<"stages">;
          status: "active" | "deleted";
          updatedAt: number;
          workspaceRef?: string;
        }>
      >;
      listActive: FunctionReference<
        "query",
        "internal",
        { accountId: Id<"accounts"> },
        Array<{
          _creationTime: number;
          _id: Id<"channelRecords">;
          accountId: Id<"accounts">;
          config: any;
          createdAt: number;
          createdBy?: Id<"users">;
          deletedAt?: number;
          description?: string;
          externalId: string;
          managedBy?: "cli" | "dashboard" | "api";
          name: string;
          platform: string;
          projectId?: Id<"projects">;
          stageId?: Id<"stages">;
          status: "active" | "deleted";
          updatedAt: number;
          workspaceRef?: string;
        }>
      >;
      listActivePage: FunctionReference<
        "query",
        "internal",
        {
          accountId: Id<"accounts">;
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            _creationTime: number;
            _id: Id<"channelRecords">;
            accountId: Id<"accounts">;
            config: any;
            createdAt: number;
            createdBy?: Id<"users">;
            deletedAt?: number;
            description?: string;
            externalId: string;
            managedBy?: "cli" | "dashboard" | "api";
            name: string;
            platform: string;
            projectId?: Id<"projects">;
            stageId?: Id<"stages">;
            status: "active" | "deleted";
            updatedAt: number;
            workspaceRef?: string;
          }>;
          pageStatus?: "SplitRecommended" | "SplitRequired" | null;
          splitCursor?: string | null;
        }
      >;
      remove: FunctionReference<
        "mutation",
        "internal",
        { accountId: Id<"accounts">; channelRecordId: string },
        null
      >;
      update: FunctionReference<
        "mutation",
        "internal",
        {
          accountId: Id<"accounts">;
          channelRecordId: string;
          config?: any;
          description?: string | null;
          name?: string;
          status?: "active" | "deleted";
          workspaceRef?: string | null;
        },
        null
      >;
    };
  };
  cli: {
    auth: {
      createOnboardingOrg: FunctionReference<
        "mutation",
        "internal",
        { name: string; tokenHash: string },
        null | {
          account: null | {
            id: Id<"accounts">;
            status: "active" | "disabled";
            username: string;
          };
          currentOrgId: Id<"orgs">;
          orgs: Array<{
            accountStatus: "active" | "missing" | "disabled";
            id: Id<"orgs">;
            name: string;
            plan: "free" | "pro";
            role: "owner" | "admin" | "member";
            slug: string;
          }>;
          projects: Array<{ id: Id<"projects">; name: string; slug: string }>;
          user: { authId: string; email: string; name: string };
        }
      >;
      exchangeLoginCode: FunctionReference<
        "mutation",
        "internal",
        { code: string; codeVerifier: string },
        {
          account: { id: string; username: string };
          expiresAt: number;
          org: { id: string; name: string; slug: string };
          token: string;
          user: { authId: string; email: string; name: string };
        }
      >;
      getOnboardingContext: FunctionReference<
        "mutation",
        "internal",
        { tokenHash: string },
        null | {
          account: null | {
            id: Id<"accounts">;
            status: "active" | "disabled";
            username: string;
          };
          currentOrgId: Id<"orgs">;
          orgs: Array<{
            accountStatus: "active" | "missing" | "disabled";
            id: Id<"orgs">;
            name: string;
            plan: "free" | "pro";
            role: "owner" | "admin" | "member";
            slug: string;
          }>;
          projects: Array<{ id: Id<"projects">; name: string; slug: string }>;
          user: { authId: string; email: string; name: string };
        }
      >;
      resolveCliToken: FunctionReference<
        "mutation",
        "internal",
        { tokenHash: string },
        null | {
          accountId: Id<"accounts">;
          authId: string;
          cliTokenId: Id<"cliTokens">;
          orgId: Id<"orgs">;
          secretHash: string;
        }
      >;
      selectOnboardingOrg: FunctionReference<
        "mutation",
        "internal",
        { orgId: Id<"orgs">; tokenHash: string },
        null | {
          account: null | {
            id: Id<"accounts">;
            status: "active" | "disabled";
            username: string;
          };
          currentOrgId: Id<"orgs">;
          orgs: Array<{
            accountStatus: "active" | "missing" | "disabled";
            id: Id<"orgs">;
            name: string;
            plan: "free" | "pro";
            role: "owner" | "admin" | "member";
            slug: string;
          }>;
          projects: Array<{ id: Id<"projects">; name: string; slug: string }>;
          user: { authId: string; email: string; name: string };
        }
      >;
    };
    projects: {
      listByAccount: FunctionReference<
        "query",
        "internal",
        { accountId: Id<"accounts"> },
        null | Array<{
          agentCount: number;
          deploymentCount: number;
          empty: boolean;
          fileCount: number;
          id: Id<"projects">;
          name: string;
          slug: string;
          stageCount: number;
          updatedAt: number;
          variableCount: number;
        }>
      >;
      removeByAccount: FunctionReference<
        "mutation",
        "internal",
        { accountId: Id<"accounts">; authId: string; projectId: string },
        | null
        | "forbidden"
        | {
            agentCount: number;
            deploymentCount: number;
            empty: boolean;
            fileCount: number;
            id: Id<"projects">;
            name: string;
            slug: string;
            stageCount: number;
            updatedAt: number;
            variableCount: number;
          }
      >;
    };
    stages: {
      createByAccount: FunctionReference<
        "mutation",
        "internal",
        {
          accountId: Id<"accounts">;
          duplicateFrom?: string;
          name: string;
          project: string;
        },
        null | {
          clonedFrom: null | string;
          stage: {
            agentCount: number;
            deploymentRegion?: "ap-southeast-1" | "eu-west-1" | "us-east-1";
            id: Id<"stages">;
            isDefault: boolean;
            kind: "development" | "production" | "custom";
            name: string;
            updatedAt: number;
            variableCount: number;
          };
        }
      >;
      listByAccount: FunctionReference<
        "query",
        "internal",
        { accountId: Id<"accounts">; project: string },
        null | Array<{
          agentCount: number;
          deploymentRegion?: "ap-southeast-1" | "eu-west-1" | "us-east-1";
          id: Id<"stages">;
          isDefault: boolean;
          kind: "development" | "production" | "custom";
          name: string;
          updatedAt: number;
          variableCount: number;
        }>
      >;
      mintSessionByAccount: FunctionReference<
        "mutation",
        "internal",
        { accountId: Id<"accounts">; project: string; stage: string },
        null | {
          expiresAt: number;
          projectSlug: string;
          stageSlug: string;
          token: string;
        }
      >;
    };
    sync: {
      deleteResourceBySecretHash: FunctionReference<
        "mutation",
        "internal",
        {
          kind: "agent" | "workspace" | "sandbox";
          name: string;
          project: string;
          secretHash: string;
          stage: string;
        },
        { reserved: boolean }
      >;
      deleteTargetsBySecretHash: FunctionReference<
        "query",
        "internal",
        {
          project: string;
          secretHash: string;
          stage: string;
          target:
            | {
                resources: Array<{
                  config: any;
                  description?: string;
                  kind:
                    | "agent"
                    | "workspace"
                    | "sandbox"
                    | "cron"
                    | "skill"
                    | "hook"
                    | "mcp"
                    | "policy"
                    | "channelRecord";
                  name: string;
                }>;
              }
            | { kind: "workspace" | "sandbox"; name: string };
        },
        Array<{ sandboxConfigId: Id<"sandboxConfigs"> } | { namespace: string }>
      >;
      ensureRuntimeKeyBySecretHash: FunctionReference<
        "mutation",
        "internal",
        {
          auditSync?: {
            actorId?: string;
            actorKind: "cli" | "deployKey";
            prune: boolean;
            resourceCount: number;
          };
          createdByAuthId?: string;
          project: string;
          rotate?: boolean;
          secretHash: string;
          stage: string;
        },
        null | {
          accountId: Id<"accounts">;
          apiKey: string;
          endpointId: string;
          keyHint: string;
          projectSlug: string;
          stageKind: "development" | "production" | "custom";
          stageSlug: string;
          userTokenSecretHint?: string;
        }
      >;
      ensureScopeBySecretHash: FunctionReference<
        "mutation",
        "internal",
        {
          project: string;
          region?: "ap-southeast-1" | "eu-west-1" | "us-east-1";
          revision?: number;
          secretHash: string;
          stage: string;
        },
        { projectId: Id<"projects">; revision: number; stageId: Id<"stages"> }
      >;
      finishManifestSync: FunctionReference<
        "mutation",
        "internal",
        { revision: number; stageId: Id<"stages"> },
        null
      >;
      getEnvBySecretHash: FunctionReference<
        "mutation",
        "internal",
        {
          name: string;
          project: string;
          revealedByCliAuthId?: string;
          revealedByCliTokenId?: Id<"cliTokens">;
          revealedByDeployKeyId?: Id<"deployKeys">;
          secretHash: string;
          stage: string;
        },
        null | { value: string }
      >;
      getManifestBySecretHash: FunctionReference<
        "query",
        "internal",
        { project: string; secretHash: string; stage: string },
        null | {
          ids: {
            agents: Record<string, string>;
            channelRecords: Record<string, string>;
            crons: Record<string, string>;
            hooks: Record<string, string>;
            mcp: Record<string, string>;
            policies: Record<string, string>;
            sandboxes: Record<string, string>;
            skills: Record<string, string>;
            workspaces: Record<string, string>;
          };
          manifest: any;
          revision: number;
        }
      >;
      listEnvBySecretHash: FunctionReference<
        "query",
        "internal",
        { project: string; secretHash: string; stage: string },
        Array<{ name: string; updatedAt: number; valueDigest: string }>
      >;
      listExternalResourcesForAccount: FunctionReference<
        "query",
        "internal",
        { accountId: Id<"accounts"> },
        Array<{
          externalId: string;
          kind: "skill" | "hook" | "mcp";
          name: string;
          stageId: Id<"stages">;
        }>
      >;
      pruneSandboxesBySecretHash: FunctionReference<
        "mutation",
        "internal",
        {
          manifest: {
            project: string;
            region?: "ap-southeast-1" | "eu-west-1" | "us-east-1";
            resources: Array<{
              config: any;
              description?: string;
              kind:
                | "agent"
                | "workspace"
                | "sandbox"
                | "cron"
                | "skill"
                | "hook"
                | "mcp"
                | "policy"
                | "channelRecord";
              name: string;
            }>;
            stage: string;
            version: 1;
          };
          secretHash: string;
        },
        Array<string>
      >;
      recordExternalResourcesBySecretHash: FunctionReference<
        "mutation",
        "internal",
        {
          ids: {
            hooks: Record<string, string>;
            mcp: Record<string, string>;
            skills: Record<string, string>;
          };
          project: string;
          prune?: boolean;
          resources: Array<{
            config: any;
            description?: string;
            kind:
              | "agent"
              | "workspace"
              | "sandbox"
              | "cron"
              | "skill"
              | "hook"
              | "mcp"
              | "policy"
              | "channelRecord";
            name: string;
          }>;
          secretHash: string;
          stage: string;
        },
        null
      >;
      removeEnvBySecretHash: FunctionReference<
        "mutation",
        "internal",
        { name: string; project: string; secretHash: string; stage: string },
        { removed: boolean }
      >;
      replaceSkillNodeFilesBySecretHash: FunctionReference<
        "mutation",
        "internal",
        {
          files: Array<{
            mimeType?: string;
            name: string;
            path: string;
            sizeBytes?: number;
            storageId: Id<"_storage">;
          }>;
          project: string;
          secretHash: string;
          skillName: string;
          stage: string;
        },
        null
      >;
      resolveCliAuth: FunctionReference<
        "query",
        "internal",
        {
          keyKind: "account" | "project";
          project: string;
          stage: string;
          tokenHash: string;
        },
        null | {
          accountId: Id<"accounts">;
          deployKeyId?: Id<"deployKeys">;
          scoped: boolean;
          secretHash: string;
        }
      >;
      rotateUserTokenSecretBySecretHash: FunctionReference<
        "mutation",
        "internal",
        {
          actorId?: string;
          actorKind: "cli" | "deployKey";
          cliAuthId?: string;
          project: string;
          secretHash: string;
          stage: string;
        },
        null | { hint: string; secret: string }
      >;
      setEnvBySecretHash: FunctionReference<
        "mutation",
        "internal",
        {
          name: string;
          project: string;
          secretHash: string;
          stage: string;
          value: string;
        },
        null
      >;
      syncManifestBySecretHash: FunctionReference<
        "mutation",
        "internal",
        {
          manifest: {
            project: string;
            region?: "ap-southeast-1" | "eu-west-1" | "us-east-1";
            resources: Array<{
              config: any;
              description?: string;
              kind:
                | "agent"
                | "workspace"
                | "sandbox"
                | "cron"
                | "skill"
                | "hook"
                | "mcp"
                | "policy"
                | "channelRecord";
              name: string;
            }>;
            stage: string;
            version: 1;
          };
          prune?: boolean;
          secretHash: string;
        },
        {
          ids: {
            agents: Record<string, string>;
            channelRecords: Record<string, string>;
            crons: Record<string, string>;
            hooks: Record<string, string>;
            mcp: Record<string, string>;
            policies: Record<string, string>;
            sandboxes: Record<string, string>;
            skills: Record<string, string>;
            workspaces: Record<string, string>;
          };
          manifest: any;
          warnings: { missingPolicies: Array<string> };
        }
      >;
      validateManifestForStage: FunctionReference<
        "query",
        "internal",
        {
          manifest: {
            project: string;
            region?: "ap-southeast-1" | "eu-west-1" | "us-east-1";
            resources: Array<{
              config: any;
              description?: string;
              kind:
                | "agent"
                | "workspace"
                | "sandbox"
                | "cron"
                | "skill"
                | "hook"
                | "mcp"
                | "policy"
                | "channelRecord";
              name: string;
            }>;
            stage: string;
            version: 1;
          };
          projectId: Id<"projects">;
          stageId: Id<"stages">;
        },
        null
      >;
    };
  };
  config: {
    authFailures: {
      pruneExpired: FunctionReference<
        "mutation",
        "internal",
        { batchSize?: number; now?: number },
        number
      >;
      recordAuthFailure: FunctionReference<
        "mutation",
        "internal",
        {
          blockMs: number;
          key: string;
          maxFailures: number;
          now: number;
          windowMs: number;
        },
        { blocked: boolean; retryAfterMs?: number }
      >;
    };
  };
  mcp: {
    nodeContext: FunctionReference<
      "query",
      "internal",
      {
        nodeId: string;
        projectId: Id<"projects">;
        requiredRole?: "owner" | "admin" | "member";
        stageId: Id<"stages">;
      },
      {
        accountId: Id<"accounts">;
        existing: null | {
          _creationTime: number;
          _id: Id<"mcp">;
          accountId: Id<"accounts">;
          allowedTools?: Array<string>;
          bundleStorageKey?: string;
          command?: Array<string>;
          createdAt: number;
          deletedAt?: number;
          description?: string;
          disabled?: boolean;
          headers?: Record<string, string>;
          name: string;
          nodeId?: string;
          oauth?: {
            clientId: string;
            clientSecret: string;
            refreshToken: string;
            tokenUrl?: string;
          };
          projectId: Id<"projects">;
          runtime?: "auto" | "lambda";
          sandbox?: string;
          sha256?: string;
          sourceCode?: string;
          stageId: Id<"stages">;
          status: "active" | "deleted";
          transport: "http" | "hosted" | "machine";
          updatedAt: number;
          url?: string;
          workersCompatible?: boolean;
        };
      }
    >;
  };
  observedMigration: {
    stripObserved: FunctionReference<"mutation", "internal", {}, number>;
  };
  org: {
    orgs: {
      adoptExternalAccount: FunctionReference<
        "mutation",
        "internal",
        { accountId: Id<"accounts">; orgName: string; ownerEmail: string },
        { membershipId: Id<"orgMembers">; orgId: Id<"orgs">; slug: string }
      >;
      getByIdForKeyWriter: FunctionReference<
        "query",
        "internal",
        { orgId: Id<"orgs"> },
        {
          _creationTime: number;
          _id: Id<"orgs">;
          createdAt: number;
          name: string;
          onboardedAt?: number;
          ownerAuthId: string;
          plan: "free" | "pro";
          slug: string;
        } | null
      >;
      userIdByAuthId: FunctionReference<
        "query",
        "internal",
        { authId: string },
        Id<"users"> | null
      >;
    };
    workosUserDeletion: {
      finalize: FunctionReference<
        "mutation",
        "internal",
        { authId: string },
        null
      >;
      listSoleOwnedAccounts: FunctionReference<
        "query",
        "internal",
        { authId: string },
        Array<Id<"accounts">>
      >;
      scheduleRetry: FunctionReference<
        "mutation",
        "internal",
        { authId: string },
        null | number
      >;
    };
    workosUserDeletionCleanup: {
      run: FunctionReference<"action", "internal", { authId: string }, null>;
    };
  };
  runtime: {
    appendConversationEvent: FunctionReference<
      "mutation",
      "internal",
      {
        conversationKey: string;
        events: Array<{ cursor: string; dedupeKey?: string; event: any }>;
      },
      null
    >;
    bindAsyncToolResultSandbox: FunctionReference<
      "mutation",
      "internal",
      {
        resultId: string;
        sandbox: {
          externalId: string;
          provider:
            | "sandbox"
            | "lambda"
            | "e2b"
            | "daytona"
            | "vercel"
            | "cloudflare"
            | "worker"
            | "machine"
            | "custom";
          reservationKey: string;
        };
      },
      null
    >;
    claimEvent: FunctionReference<
      "mutation",
      "internal",
      { accountId: Id<"accounts">; key: string; ttlSeconds: number },
      boolean
    >;
    claimSandboxReservation: FunctionReference<
      "mutation",
      "internal",
      {
        accountId: Id<"accounts">;
        externalId: string;
        provider:
          | "sandbox"
          | "lambda"
          | "e2b"
          | "daytona"
          | "vercel"
          | "cloudflare"
          | "worker"
          | "machine"
          | "custom";
        reservationKey: string;
        ttlSeconds?: number;
      },
      boolean
    >;
    clearConversation: FunctionReference<
      "mutation",
      "internal",
      { conversationKey: string },
      { deleted: number; hasMore: boolean }
    >;
    createAsyncAgentResult: FunctionReference<
      "mutation",
      "internal",
      {
        conversationKey: string;
        eventId: string;
        subagent?: {
          description?: string;
          parentConversationKey: string;
          parentDelivery?:
            | { kind: "async" }
            | {
                connectionId: string;
                kind: "nats";
                publicConversationKey: string;
                publicEventId: string;
              }
            | {
                channelName: string;
                identity?: {
                  channelId?: string;
                  threadId?: string;
                  userId?: string;
                  userName?: string;
                  userRoles?: Array<string>;
                  workspaceRef?: string;
                };
                kind: "channel";
                source: Record<string, any>;
              };
        };
      },
      boolean
    >;
    createAsyncToolResult: FunctionReference<
      "mutation",
      "internal",
      {
        completionToken?: string;
        conversationKey: string;
        delivery?: any;
        input: any;
        parentEventId: string;
        resultId: string;
        toolCallId: string;
        toolName: string;
      },
      boolean
    >;
    deferSandboxReservations: FunctionReference<
      "mutation",
      "internal",
      {
        accountId: Id<"accounts">;
        reservations: Array<{
          provider:
            | "sandbox"
            | "lambda"
            | "e2b"
            | "daytona"
            | "vercel"
            | "cloudflare"
            | "worker"
            | "machine"
            | "custom";
          reservationKey: string;
        }>;
      },
      number
    >;
    deleteAccountRuntimeData: FunctionReference<
      "mutation",
      "internal",
      { accountId: Id<"accounts"> },
      {
        asyncAgentResultDeleted: number;
        asyncToolResultDeleted: number;
        conversationsDeleted: number;
        harnessSessionDeleted: number;
        processedEventsDeleted: number;
        sandboxReservationDeleted: number;
        totalDeleted: number;
      }
    >;
    deleteAgentRuntimeData: FunctionReference<
      "mutation",
      "internal",
      { accountId: Id<"accounts">; agentId: string },
      {
        applicationDeleted: number;
        asyncAgentResultDeleted: number;
        asyncToolResultDeleted: number;
        conversationsDeleted: number;
        coordinatorDeleted: number;
        harnessSessionDeleted: number;
        ingressDeleted: number;
        totalDeleted: number;
      }
    >;
    deleteSandboxReservation: FunctionReference<
      "mutation",
      "internal",
      {
        accountId: Id<"accounts">;
        expectedExternalId?: string;
        onlyExpired?: boolean;
        provider:
          | "sandbox"
          | "lambda"
          | "e2b"
          | "daytona"
          | "vercel"
          | "cloudflare"
          | "worker"
          | "machine"
          | "custom";
        reservationKey: string;
      },
      boolean
    >;
    getAsyncAgentResult: FunctionReference<
      "query",
      "internal",
      { eventId: string },
      {
        _creationTime: number;
        _id: Id<"runtimeAsyncAgentResults">;
        accountId: Id<"accounts">;
        approvals?: Array<any>;
        conversationKey: string;
        createdAt: string;
        error?: string;
        eventId: string;
        expiresAt: number;
        handback?: "pending" | "detached" | "stored";
        observed?: boolean;
        questions?: Array<any>;
        response?: any;
        status:
          | "processing"
          | "awaiting_approval"
          | "awaiting_input"
          | "completed"
          | "failed";
        subagent?: {
          description?: string;
          parentConversationKey: string;
          parentDelivery?:
            | { kind: "async" }
            | {
                connectionId: string;
                kind: "nats";
                publicConversationKey: string;
                publicEventId: string;
              }
            | {
                channelName: string;
                identity?: {
                  channelId?: string;
                  threadId?: string;
                  userId?: string;
                  userName?: string;
                  userRoles?: Array<string>;
                  workspaceRef?: string;
                };
                kind: "channel";
                source: Record<string, any>;
              };
        };
        updatedAt: string;
      } | null
    >;
    getAsyncToolResult: FunctionReference<
      "query",
      "internal",
      { resultId: string },
      {
        _creationTime: number;
        _id: Id<"runtimeAsyncToolResults">;
        accountId: Id<"accounts">;
        conversationKey: string;
        createdAt: string;
        delivery?: any;
        error?: string;
        expiresAt: number;
        handback?: "pending" | "detached" | "stored";
        input: any;
        observed?: boolean;
        parentEventId: string;
        response?: any;
        resultId: string;
        sandbox?: {
          externalId: string;
          provider:
            | "sandbox"
            | "lambda"
            | "e2b"
            | "daytona"
            | "vercel"
            | "cloudflare"
            | "worker"
            | "machine"
            | "custom";
          reservationKey: string;
        };
        status: "processing" | "completed" | "failed";
        toolCallId: string;
        toolName: string;
        updatedAt: string;
      } | null
    >;
    getAsyncToolToken: FunctionReference<
      "query",
      "internal",
      { completionToken: string; resultId: string },
      boolean
    >;
    getHarnessSession: FunctionReference<
      "query",
      "internal",
      { conversationKey: string },
      {
        harnessType: "claude-code" | "codex" | "deepagents" | "opencode" | "pi";
        reservationKey?: string;
        resumeState: any;
        sessionId: string;
      } | null
    >;
    getSandboxReleaseTarget: FunctionReference<
      "query",
      "internal",
      {
        accountId: Id<"accounts">;
        externalId?: string;
        provider:
          | "sandbox"
          | "lambda"
          | "e2b"
          | "daytona"
          | "vercel"
          | "cloudflare"
          | "worker"
          | "machine"
          | "custom";
        reservationKey: string;
      },
      {
        externalId: string | null;
        instance: {
          ownCredentials: boolean;
          sandboxConfigId?: Id<"sandboxConfigs">;
        } | null;
      }
    >;
    getSandboxReservation: FunctionReference<
      "query",
      "internal",
      {
        provider:
          | "sandbox"
          | "lambda"
          | "e2b"
          | "daytona"
          | "vercel"
          | "cloudflare"
          | "worker"
          | "machine"
          | "custom";
        reservationKey: string;
      },
      string | null
    >;
    getSandboxReservationRecord: FunctionReference<
      "query",
      "internal",
      {
        provider:
          | "sandbox"
          | "lambda"
          | "e2b"
          | "daytona"
          | "vercel"
          | "cloudflare"
          | "worker"
          | "machine"
          | "custom";
        reservationKey: string;
      },
      { claimedAt: number; expiresAt: number; externalId: string } | null
    >;
    listAccountSandboxReservations: FunctionReference<
      "query",
      "internal",
      { accountId: Id<"accounts">; cursor?: string | null },
      {
        cursor: string | null;
        isDone: boolean;
        page: Array<{
          accountId: Id<"accounts">;
          externalId: string;
          provider:
            | "sandbox"
            | "lambda"
            | "e2b"
            | "daytona"
            | "vercel"
            | "cloudflare"
            | "worker"
            | "machine"
            | "custom";
          reservationKey: string;
          ttlSeconds?: number;
        }>;
      }
    >;
    listBuildingSandboxSnapshots: FunctionReference<
      "query",
      "internal",
      {},
      Array<{
        accountId: Id<"accounts">;
        baseImage: string;
        externalImageId: string;
        name: string;
        provider:
          | "sandbox"
          | "lambda"
          | "e2b"
          | "daytona"
          | "vercel"
          | "cloudflare"
          | "worker"
          | "machine"
          | "custom";
        scope: "account" | { projectId: Id<"projects">; stageId: Id<"stages"> };
      }>
    >;
    listConversationEvents: FunctionReference<
      "query",
      "internal",
      {
        afterCursor?: string;
        beforeCursor?: string;
        conversationKey: string;
        fromSystemPrefix?: string;
      },
      {
        continueCursor: string | null;
        isDone: boolean;
        page: Array<{ cursor: string; event: any }>;
      }
    >;
    listExpiredSandboxReservations: FunctionReference<
      "query",
      "internal",
      { limit: number },
      Array<{
        accountId: Id<"accounts">;
        externalId: string;
        provider:
          | "sandbox"
          | "lambda"
          | "e2b"
          | "daytona"
          | "vercel"
          | "cloudflare"
          | "worker"
          | "machine"
          | "custom";
        reservationKey: string;
        ttlSeconds?: number;
      }>
    >;
    listOrphanedSandboxInstances: FunctionReference<
      "query",
      "internal",
      { cursor: string | null; limit: number },
      {
        cursor: string | null;
        isDone: boolean;
        page: Array<{
          accountId: Id<"accounts">;
          externalId: string;
          provider:
            | "sandbox"
            | "lambda"
            | "e2b"
            | "daytona"
            | "vercel"
            | "cloudflare"
            | "worker"
            | "machine"
            | "custom";
          reservationKey: string;
          ttlSeconds?: number;
        }>;
      }
    >;
    listOwedAsyncAgentResults: FunctionReference<
      "query",
      "internal",
      {
        cursor: string | null;
        handback: "detached" | "pending";
        status:
          | "processing"
          | "awaiting_approval"
          | "awaiting_input"
          | "completed"
          | "failed";
        updatedAfter: string;
        updatedBefore: string;
      },
      {
        cursor: string;
        isDone: boolean;
        page: Array<{
          _creationTime: number;
          _id: Id<"runtimeAsyncAgentResults">;
          accountId: Id<"accounts">;
          approvals?: Array<any>;
          conversationKey: string;
          createdAt: string;
          error?: string;
          eventId: string;
          expiresAt: number;
          handback?: "pending" | "detached" | "stored";
          observed?: boolean;
          questions?: Array<any>;
          response?: any;
          status:
            | "processing"
            | "awaiting_approval"
            | "awaiting_input"
            | "completed"
            | "failed";
          subagent?: {
            description?: string;
            parentConversationKey: string;
            parentDelivery?:
              | { kind: "async" }
              | {
                  connectionId: string;
                  kind: "nats";
                  publicConversationKey: string;
                  publicEventId: string;
                }
              | {
                  channelName: string;
                  identity?: {
                    channelId?: string;
                    threadId?: string;
                    userId?: string;
                    userName?: string;
                    userRoles?: Array<string>;
                    workspaceRef?: string;
                  };
                  kind: "channel";
                  source: Record<string, any>;
                };
          };
          updatedAt: string;
        }>;
      }
    >;
    listOwedAsyncToolResults: FunctionReference<
      "query",
      "internal",
      {
        cursor: string | null;
        handback: "detached" | "pending";
        status: "processing" | "completed" | "failed";
        updatedAfter: string;
        updatedBefore: string;
      },
      {
        cursor: string;
        isDone: boolean;
        page: Array<{
          _creationTime: number;
          _id: Id<"runtimeAsyncToolResults">;
          accountId: Id<"accounts">;
          conversationKey: string;
          createdAt: string;
          delivery?: any;
          error?: string;
          expiresAt: number;
          handback?: "pending" | "detached" | "stored";
          input: any;
          observed?: boolean;
          parentEventId: string;
          response?: any;
          resultId: string;
          sandbox?: {
            externalId: string;
            provider:
              | "sandbox"
              | "lambda"
              | "e2b"
              | "daytona"
              | "vercel"
              | "cloudflare"
              | "worker"
              | "machine"
              | "custom";
            reservationKey: string;
          };
          status: "processing" | "completed" | "failed";
          toolCallId: string;
          toolName: string;
          updatedAt: string;
        }>;
      }
    >;
    listPendingAsyncToolResults: FunctionReference<
      "query",
      "internal",
      { conversationKey: string; toolName: string },
      Array<{
        _creationTime: number;
        _id: Id<"runtimeAsyncToolResults">;
        accountId: Id<"accounts">;
        conversationKey: string;
        createdAt: string;
        delivery?: any;
        error?: string;
        expiresAt: number;
        handback?: "pending" | "detached" | "stored";
        input: any;
        observed?: boolean;
        parentEventId: string;
        response?: any;
        resultId: string;
        sandbox?: {
          externalId: string;
          provider:
            | "sandbox"
            | "lambda"
            | "e2b"
            | "daytona"
            | "vercel"
            | "cloudflare"
            | "worker"
            | "machine"
            | "custom";
          reservationKey: string;
        };
        status: "processing" | "completed" | "failed";
        toolCallId: string;
        toolName: string;
        updatedAt: string;
      }>
    >;
    markAsyncAgentHandback: FunctionReference<
      "mutation",
      "internal",
      { eventId: string; handback: "detached" | "stored" },
      null
    >;
    markAsyncToolHandback: FunctionReference<
      "mutation",
      "internal",
      { handback: "detached" | "stored"; resultId: string },
      null
    >;
    pruneExpired: FunctionReference<"mutation", "internal", {}, number>;
    releaseClaim: FunctionReference<
      "mutation",
      "internal",
      { accountId: Id<"accounts">; key: string },
      null
    >;
    saveSandboxReservation: FunctionReference<
      "mutation",
      "internal",
      {
        accountId: Id<"accounts">;
        externalId: string;
        provider:
          | "sandbox"
          | "lambda"
          | "e2b"
          | "daytona"
          | "vercel"
          | "cloudflare"
          | "worker"
          | "machine"
          | "custom";
        reservationKey: string;
        ttlSeconds?: number;
      },
      null
    >;
    updateAsyncAgentResult: FunctionReference<
      "mutation",
      "internal",
      {
        approvals?: Array<any>;
        error?: string;
        eventId: string;
        handback?: "detached";
        onlyWhileProcessing?: boolean;
        questions?: Array<any>;
        response?: any;
        status:
          | "processing"
          | "awaiting_approval"
          | "awaiting_input"
          | "completed"
          | "failed";
      },
      null
    >;
    updateAsyncToolResult: FunctionReference<
      "mutation",
      "internal",
      {
        error?: string;
        onlyWhenProcessing?: boolean;
        response?: any;
        resultId: string;
        status: "processing" | "completed" | "failed";
      },
      {
        _creationTime: number;
        _id: Id<"runtimeAsyncToolResults">;
        accountId: Id<"accounts">;
        conversationKey: string;
        createdAt: string;
        delivery?: any;
        error?: string;
        expiresAt: number;
        handback?: "pending" | "detached" | "stored";
        input: any;
        observed?: boolean;
        parentEventId: string;
        response?: any;
        resultId: string;
        sandbox?: {
          externalId: string;
          provider:
            | "sandbox"
            | "lambda"
            | "e2b"
            | "daytona"
            | "vercel"
            | "cloudflare"
            | "worker"
            | "machine"
            | "custom";
          reservationKey: string;
        };
        status: "processing" | "completed" | "failed";
        toolCallId: string;
        toolName: string;
        updatedAt: string;
      } | null
    >;
  };
  runtimeIngress: {
    accept: FunctionReference<
      "mutation",
      "internal",
      {
        accountId: Id<"accounts">;
        activeOwnerOnly?: boolean;
        agentId: string;
        channelTarget?: {
          channelName: string;
          channelRecordId?: string;
          credentialAgentId?: string;
          source: Record<string, any>;
        };
        configRef?: {
          channel?: {
            channelName: string;
            channelRecordId?: string;
            credentialAgentId?: string;
          };
          model?: Record<string, any>;
        };
        conversationKey: string;
        delivery: any;
        envelopeTtlMs: number;
        ephemeralSystem?: Array<any>;
        eventId: string;
        events: Array<any>;
        expectedOwnerTaskId?: string;
        idempotencyKey: string;
        leaseTtlMs: number;
        maxQueuedBytes: number;
        maxQueuedCount: number;
        ownerTaskId?: string;
        payloadDigest: string;
        requestedMode: "reject" | "followup" | "collect" | "steer";
        resultEventId?: string;
        runId: string;
        sizeBytes: number;
        statusTtlMs: number;
        toolResultId?: string;
      },
      {
        eventId?: string;
        outcome:
          | "owner"
          | "queued"
          | "duplicate"
          | "rejected"
          | "capacity"
          | "conflict"
          | "not_running";
        ownerGeneration?: number;
        recovered?: {
          appliedMode: "reject" | "followup" | "collect" | "steer";
          appliedToEventId: string;
          configRef?: {
            channel?: {
              channelName: string;
              channelRecordId?: string;
              credentialAgentId?: string;
            };
            model?: Record<string, any>;
          };
          contributingEventIds: Array<string>;
          delivery: any;
          ephemeralSystem?: Array<any>;
          eventId: string;
          events: Array<any>;
          ownerGeneration: number;
          requestedMode: "reject" | "followup" | "collect" | "steer";
        };
        runId?: string;
        sequence?: number;
        status?:
          | "accepted"
          | "queued"
          | "applied"
          | "processing"
          | "completed"
          | "failed"
          | "expired";
      }
    >;
    acquireClear: FunctionReference<
      "mutation",
      "internal",
      {
        accountId: Id<"accounts">;
        agentId: string;
        conversationKey: string;
        leaseTtlMs: number;
        ownerEventId: string;
      },
      number | null
    >;
    appendConversationEvent: FunctionReference<
      "mutation",
      "internal",
      {
        conversationKey: string;
        events: Array<{ cursor: string; dedupeKey?: string; event: any }>;
        ownerEventId: string;
        ownerGeneration: number;
      },
      null
    >;
    applySteering: FunctionReference<
      "mutation",
      "internal",
      {
        conversationKey: string;
        leaseTtlMs: number;
        ownerEventId: string;
        ownerGeneration: number;
        textOnly?: boolean;
      },
      {
        appliedMode: "reject" | "followup" | "collect" | "steer";
        appliedToEventId: string;
        configRef?: {
          channel?: {
            channelName: string;
            channelRecordId?: string;
            credentialAgentId?: string;
          };
          model?: Record<string, any>;
        };
        contributingEventIds: Array<string>;
        delivery: any;
        ephemeralSystem?: Array<any>;
        eventId: string;
        events: Array<any>;
        ownerGeneration: number;
        requestedMode: "reject" | "followup" | "collect" | "steer";
      } | null
    >;
    clearConversation: FunctionReference<
      "mutation",
      "internal",
      {
        conversationKey: string;
        ownerEventId: string;
        ownerGeneration: number;
      },
      { deleted: number; hasMore: boolean }
    >;
    getConversationTarget: FunctionReference<
      "query",
      "internal",
      { accountId: Id<"accounts">; agentId: string; conversationKey: string },
      {
        channelName: string;
        channelRecordId?: string;
        credentialAgentId?: string;
        source: Record<string, any>;
      } | null
    >;
    getStatus: FunctionReference<
      "query",
      "internal",
      { accountId: Id<"accounts">; runId: string },
      {
        agentId: string;
        appliedMode?: "reject" | "followup" | "collect" | "steer";
        appliedToEventId?: string;
        conversationKey: string;
        createdAt: number;
        error?: string;
        eventId: string;
        expiresAt: number;
        publicDeploymentIngress?: {
          accountId: string;
          endpointId: string;
          projectSlug: string;
          stageSlug: string;
        };
        requestedMode: "reject" | "followup" | "collect" | "steer";
        result?: any;
        runId: string;
        status:
          | "accepted"
          | "queued"
          | "applied"
          | "processing"
          | "completed"
          | "failed"
          | "expired";
        stoppedByUser?: boolean;
        updatedAt: number;
      } | null
    >;
    getStatusByEventId: FunctionReference<
      "query",
      "internal",
      { accountId: Id<"accounts">; agentId: string; eventId: string },
      {
        agentId: string;
        appliedMode?: "reject" | "followup" | "collect" | "steer";
        appliedToEventId?: string;
        conversationKey: string;
        createdAt: number;
        error?: string;
        eventId: string;
        expiresAt: number;
        publicDeploymentIngress?: {
          accountId: string;
          endpointId: string;
          projectSlug: string;
          stageSlug: string;
        };
        requestedMode: "reject" | "followup" | "collect" | "steer";
        result?: any;
        runId: string;
        status:
          | "accepted"
          | "queued"
          | "applied"
          | "processing"
          | "completed"
          | "failed"
          | "expired";
        stoppedByUser?: boolean;
        updatedAt: number;
      } | null
    >;
    isCurrentOwner: FunctionReference<
      "query",
      "internal",
      {
        conversationKey: string;
        ownerEventId: string;
        ownerGeneration: number;
      },
      boolean
    >;
    maintain: FunctionReference<
      "mutation",
      "internal",
      {},
      { deleted: number; expired: number }
    >;
    recoverQueued: FunctionReference<
      "mutation",
      "internal",
      { afterConversationKey?: string; leaseTtlMs: number },
      {
        continueAfter: string | null;
        recovered: Array<{
          accountId: Id<"accounts">;
          agentId: string;
          applied: {
            appliedMode: "reject" | "followup" | "collect" | "steer";
            appliedToEventId: string;
            configRef?: {
              channel?: {
                channelName: string;
                channelRecordId?: string;
                credentialAgentId?: string;
              };
              model?: Record<string, any>;
            };
            contributingEventIds: Array<string>;
            delivery: any;
            ephemeralSystem?: Array<any>;
            eventId: string;
            events: Array<any>;
            ownerGeneration: number;
            requestedMode: "reject" | "followup" | "collect" | "steer";
          };
          conversationKey: string;
        }>;
      }
    >;
    releaseOwner: FunctionReference<
      "mutation",
      "internal",
      {
        conversationKey: string;
        ownerEventId: string;
        ownerGeneration: number;
      },
      boolean
    >;
    renewOwner: FunctionReference<
      "mutation",
      "internal",
      {
        conversationKey: string;
        leaseTtlMs: number;
        ownerEventId: string;
        ownerGeneration: number;
      },
      "renewed" | "stopped" | "stale"
    >;
    saveHarnessSession: FunctionReference<
      "mutation",
      "internal",
      {
        conversationKey: string;
        harnessType: "claude-code" | "codex" | "deepagents" | "opencode" | "pi";
        ownerEventId: string;
        ownerGeneration: number;
        reservationKey?: string;
        resumeState: any;
        sessionId: string;
      },
      null
    >;
    settle: FunctionReference<
      "mutation",
      "internal",
      {
        asyncResult?: {
          eventIds: Array<string>;
          outcome: {
            approvals?: Array<any>;
            error?: string;
            questions?: Array<any>;
            response?: any;
            status:
              | "processing"
              | "awaiting_approval"
              | "awaiting_input"
              | "completed"
              | "failed";
          };
        };
        conversationKey: string;
        error?: string;
        events?: Array<{ cursor: string; dedupeKey?: string; event: any }>;
        ownerEventId: string;
        ownerGeneration: number;
        result?: any;
        status: "completed" | "failed";
      },
      number
    >;
    stepBoundary: FunctionReference<
      "mutation",
      "internal",
      {
        claimSteering?: boolean;
        conversationKey: string;
        events?: Array<{ cursor: string; dedupeKey?: string; event: any }>;
        leaseTtlMs: number;
        ownerEventId: string;
        ownerGeneration: number;
      },
      {
        renewal: "renewed" | "stopped" | "stale";
        steering: {
          appliedMode: "reject" | "followup" | "collect" | "steer";
          appliedToEventId: string;
          configRef?: {
            channel?: {
              channelName: string;
              channelRecordId?: string;
              credentialAgentId?: string;
            };
            model?: Record<string, any>;
          };
          contributingEventIds: Array<string>;
          delivery: any;
          ephemeralSystem?: Array<any>;
          eventId: string;
          events: Array<any>;
          ownerGeneration: number;
          requestedMode: "reject" | "followup" | "collect" | "steer";
        } | null;
      }
    >;
    stopOwner: FunctionReference<
      "mutation",
      "internal",
      {
        accountId: Id<"accounts">;
        agentId: string;
        conversationKey: string;
        expectedOwnerTaskId?: string;
      },
      { queuedCount: number; stopped: boolean }
    >;
    takeNext: FunctionReference<
      "mutation",
      "internal",
      {
        conversationKey: string;
        events?: Array<{ cursor: string; dedupeKey?: string; event: any }>;
        leaseTtlMs: number;
        ownerEventId: string;
        ownerGeneration: number;
        settle?: {
          error?: string;
          result?: any;
          status: "completed" | "failed";
        };
      },
      {
        appliedMode: "reject" | "followup" | "collect" | "steer";
        appliedToEventId: string;
        configRef?: {
          channel?: {
            channelName: string;
            channelRecordId?: string;
            credentialAgentId?: string;
          };
          model?: Record<string, any>;
        };
        contributingEventIds: Array<string>;
        delivery: any;
        ephemeralSystem?: Array<any>;
        eventId: string;
        events: Array<any>;
        ownerGeneration: number;
        requestedMode: "reject" | "followup" | "collect" | "steer";
      } | null
    >;
  };
  sandbox: {
    auditEvents: {
      insert: FunctionReference<
        "mutation",
        "internal",
        {
          accountId: Id<"accounts">;
          action:
            | "reserve"
            | "suspend"
            | "resume"
            | "terminate"
            | "snapshot"
            | "refresh"
            | "exec"
            | "terminal";
          actorEmail?: string;
          actorId?: string;
          actorName?: string;
          actorSource: "dashboard" | "agent" | "service" | "unknown";
          durationMs?: number;
          errorMessage?: string;
          exitCode?: number;
          provider:
            | "sandbox"
            | "lambda"
            | "e2b"
            | "daytona"
            | "vercel"
            | "cloudflare"
            | "worker"
            | "machine"
            | "custom";
          reservationKey: string;
          result: "ok" | "error";
          sandboxConfigId?: Id<"sandboxConfigs">;
          status?:
            "running" | "suspending" | "suspended" | "terminating" | "error";
          taskId?: string;
          traceId?: string;
          truncated?: boolean;
        },
        null
      >;
    };
    configs: {
      create: FunctionReference<
        "mutation",
        "internal",
        {
          accountId: Id<"accounts">;
          description?: string;
          encryptedConfig?: string;
          encryptionIv?: string;
          encryptionTag?: string;
          name: string;
        },
        Id<"sandboxConfigs">
      >;
      getById: FunctionReference<
        "query",
        "internal",
        { accountId: Id<"accounts">; sandboxId: string },
        {
          _creationTime: number;
          _id: Id<"sandboxConfigs">;
          accountId: Id<"accounts">;
          createdAt: number;
          description?: string;
          encryptedConfig?: string;
          encryptedSourceConfig?: string;
          encryptionIv?: string;
          encryptionTag?: string;
          managedBy?: "cli" | "dashboard" | "api";
          name: string;
          projectId?: Id<"projects">;
          runtimeVariables?: Array<{ key: string; value: string }>;
          snapshotId?: string;
          sourceEncryptionIv?: string;
          sourceEncryptionTag?: string;
          stageId?: Id<"stages">;
          updatedAt: number;
        } | null
      >;
      list: FunctionReference<
        "query",
        "internal",
        { accountId: Id<"accounts"> },
        Array<{
          _creationTime: number;
          _id: Id<"sandboxConfigs">;
          accountId: Id<"accounts">;
          createdAt: number;
          description?: string;
          encryptedConfig?: string;
          encryptedSourceConfig?: string;
          encryptionIv?: string;
          encryptionTag?: string;
          managedBy?: "cli" | "dashboard" | "api";
          name: string;
          projectId?: Id<"projects">;
          runtimeVariables?: Array<{ key: string; value: string }>;
          snapshotId?: string;
          sourceEncryptionIv?: string;
          sourceEncryptionTag?: string;
          stageId?: Id<"stages">;
          updatedAt: number;
        }>
      >;
      listPage: FunctionReference<
        "query",
        "internal",
        {
          accountId: Id<"accounts">;
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            _creationTime: number;
            _id: Id<"sandboxConfigs">;
            accountId: Id<"accounts">;
            createdAt: number;
            description?: string;
            encryptedConfig?: string;
            encryptedSourceConfig?: string;
            encryptionIv?: string;
            encryptionTag?: string;
            managedBy?: "cli" | "dashboard" | "api";
            name: string;
            projectId?: Id<"projects">;
            runtimeVariables?: Array<{ key: string; value: string }>;
            snapshotId?: string;
            sourceEncryptionIv?: string;
            sourceEncryptionTag?: string;
            stageId?: Id<"stages">;
            updatedAt: number;
          }>;
          pageStatus?: "SplitRecommended" | "SplitRequired" | null;
          splitCursor?: string | null;
        }
      >;
      remove: FunctionReference<
        "mutation",
        "internal",
        { accountId: Id<"accounts">; sandboxId: string },
        null
      >;
      update: FunctionReference<
        "mutation",
        "internal",
        {
          accountId: Id<"accounts">;
          description?: string;
          encryptedConfig?: string;
          encryptionIv?: string;
          encryptionTag?: string;
          name?: string;
          sandboxId: string;
        },
        null
      >;
    };
    instances: {
      accrueRecent: FunctionReference<
        "mutation",
        "internal",
        { cursor?: string; now?: number },
        null
      >;
      isControllable: FunctionReference<
        "query",
        "internal",
        {
          accountId: Id<"accounts">;
          reservationKey: string;
          sandboxConfigId: Id<"sandboxConfigs">;
        },
        boolean
      >;
      listForAccount: FunctionReference<
        "query",
        "internal",
        { accountId: Id<"accounts"> },
        Array<{
          _creationTime: number;
          _id: Id<"sandboxInstances">;
          accountId: Id<"accounts">;
          agentId?: string;
          burstBilled?: { gbSeconds: number; vcpuSeconds: number };
          conversationKey?: string;
          createdAt: number;
          createdByTaskId?: string;
          createdByTraceId?: string;
          egress?: "allow-all" | "deny-all" | "restricted";
          ephemeral?: boolean;
          errorMessage?: string;
          externalId: string;
          idleTimeoutSeconds?: number;
          lastUsedAt: number;
          lastUsedTaskId?: string;
          lastUsedTraceId?: string;
          logStream?: string;
          meteredUntil?: number;
          name: string;
          ownCredentials?: boolean;
          permissionMode?: "edit" | "ask" | "bypass";
          projectId?: Id<"projects">;
          provider:
            | "sandbox"
            | "lambda"
            | "e2b"
            | "daytona"
            | "vercel"
            | "cloudflare"
            | "worker"
            | "machine"
            | "custom";
          reservationKey: string;
          sandboxConfigId?: Id<"sandboxConfigs">;
          snapshotId?: string;
          specs: { memoryMb: number; storageGb?: number; vcpu: number };
          specsVerified?: boolean;
          stageId?: Id<"stages">;
          status:
            "running" | "suspending" | "suspended" | "terminating" | "error";
          suspendedAt?: number;
          workspaceId?: string;
          workspaceName?: string;
        }>
      >;
      recordBurst: FunctionReference<
        "mutation",
        "internal",
        {
          accountId: Id<"accounts">;
          externalId: string;
          gbSeconds: number;
          vcpuSeconds: number;
        },
        boolean
      >;
      remove: FunctionReference<
        "mutation",
        "internal",
        {
          accountId: Id<"accounts">;
          externalId?: string;
          reservationKey: string;
        },
        null
      >;
      setSpecs: FunctionReference<
        "mutation",
        "internal",
        {
          accountId: Id<"accounts">;
          externalId: string;
          reservationKey: string;
          specs: { memoryMb: number; storageGb?: number; vcpu: number };
        },
        null
      >;
      setStatus: FunctionReference<
        "mutation",
        "internal",
        {
          accountId: Id<"accounts">;
          errorMessage?: string;
          observed?: boolean;
          reservationKey: string;
          status:
            "running" | "suspending" | "suspended" | "terminating" | "error";
        },
        boolean
      >;
      sweepStaleEphemeral: FunctionReference<
        "mutation",
        "internal",
        { now: number },
        null
      >;
      upsert: FunctionReference<
        "mutation",
        "internal",
        {
          accountId: Id<"accounts">;
          agentId?: string;
          conversationKey?: string;
          createdByTaskId?: string;
          createdByTraceId?: string;
          egress?: "allow-all" | "deny-all" | "restricted";
          ephemeral?: boolean;
          externalId: string;
          idleTimeoutSeconds?: number;
          lastUsedTaskId?: string;
          lastUsedTraceId?: string;
          logStream?: string;
          name: string;
          ownCredentials?: boolean;
          permissionMode?: "edit" | "ask" | "bypass";
          projectId?: Id<"projects">;
          provider:
            | "sandbox"
            | "lambda"
            | "e2b"
            | "daytona"
            | "vercel"
            | "cloudflare"
            | "worker"
            | "machine"
            | "custom";
          reservationKey: string;
          sandboxConfigId?: Id<"sandboxConfigs">;
          snapshotId?: string;
          specs: { memoryMb: number; storageGb?: number; vcpu: number };
          specsVerified?: boolean;
          stageId?: Id<"stages">;
          workspaceId?: string;
          workspaceName?: string;
        },
        null
      >;
    };
    machines: {
      connected: FunctionReference<
        "mutation",
        "internal",
        {
          accountId: Id<"accounts">;
          computer: boolean;
          connectionId: string;
          hostname?: string;
          mcp: Array<string>;
          platform?: string;
          sandboxConfigId: Id<"sandboxConfigs">;
          specs?: { memoryMb: number; storageGb?: number; vcpu: number };
        },
        null
      >;
      disconnected: FunctionReference<
        "mutation",
        "internal",
        {
          accountId: Id<"accounts">;
          connectionId: string;
          sandboxConfigId: Id<"sandboxConfigs">;
        },
        null
      >;
      seen: FunctionReference<
        "mutation",
        "internal",
        {
          accountId: Id<"accounts">;
          connectionId: string;
          sandboxConfigId: Id<"sandboxConfigs">;
        },
        null
      >;
    };
    snapshots: {
      assertInScope: FunctionReference<
        "query",
        "internal",
        {
          accountId: Id<"accounts">;
          scope:
            "account" | { projectId: Id<"projects">; stageId: Id<"stages"> };
          snapshot?: string;
        },
        null
      >;
      findByImage: FunctionReference<
        "query",
        "internal",
        { accountId?: Id<"accounts">; externalImageId: string },
        null | {
          accountId: Id<"accounts">;
          baseImage: string;
          scope?:
            "account" | { projectId: Id<"projects">; stageId: Id<"stages"> };
          status:
            | "pending"
            | "building"
            | "pulling"
            | "active"
            | "inactive"
            | "error"
            | "build_failed";
        }
      >;
      upsert: FunctionReference<
        "mutation",
        "internal",
        {
          accountId: Id<"accounts">;
          baseImage: string;
          externalImageId: string;
          name: string;
          provider:
            | "sandbox"
            | "lambda"
            | "e2b"
            | "daytona"
            | "vercel"
            | "cloudflare"
            | "worker"
            | "machine"
            | "custom";
          scope:
            "account" | { projectId: Id<"projects">; stageId: Id<"stages"> };
          status?:
            | "pending"
            | "building"
            | "pulling"
            | "active"
            | "inactive"
            | "error"
            | "build_failed";
        },
        null
      >;
    };
  };
  stripe: {
    applySubscriptionInternal: FunctionReference<
      "mutation",
      "internal",
      {
        subscription: {
          cancelAt?: number;
          cancelAtPeriodEnd: boolean;
          currentPeriodEnd: number;
          metadata: Record<string, string>;
          priceId: string;
          quantity: number;
          status: string;
          stripeCustomerId: string;
          stripeSubscriptionId: string;
        };
        ticket: number;
      },
      null
    >;
    cancelUserSubscriptionsInternal: FunctionReference<
      "action",
      "internal",
      { authId: string },
      null
    >;
    claimSubscriptionSyncInternal: FunctionReference<
      "mutation",
      "internal",
      { stripeSubscriptionId: string },
      number
    >;
    ownerBillingInternal: FunctionReference<
      "query",
      "internal",
      { authId: string },
      {
        developers: number;
        subscription: null | { status: string; stripeSubscriptionId: string };
      }
    >;
    syncSeatsInternal: FunctionReference<
      "action",
      "internal",
      { authId: string },
      null
    >;
  };
  usage: {
    pruneExpiredTaskUsage: FunctionReference<
      "mutation",
      "internal",
      {},
      number
    >;
    recordTaskUsage: FunctionReference<
      "mutation",
      "internal",
      {
        accountId: Id<"accounts">;
        agentId: string;
        cacheWriteTokens: number;
        cachedInputTokens: number;
        conversationKey: string;
        durationMs: number;
        endpointId: string;
        finishedAt: number;
        inputPreview?: string;
        inputTokens: number;
        modelId: string;
        modelProvider: string;
        outputTokens: number;
        principalChain?: Array<
          | { channel?: string; id: string; kind: "user"; name?: string }
          | { keyKind: "account" | "deployment" | "cron"; kind: "api" }
          | { agentId: string; kind: "agent" }
        >;
        reasoningTokens: number;
        runtimeKind: string;
        runtimeMemoryMb: number;
        runtimeWallMs: number;
        sandboxUsage: Array<{
          cpuUsec: number;
          role: "agent" | "tool";
          toolName?: string;
          type: string;
        }>;
        status: "completed" | "failed";
        stepCount: number;
        taskId: string;
        toolCallCount: number;
        totalTokens: number;
      },
      null
    >;
  };
  workspace: {
    configs: {
      create: FunctionReference<
        "mutation",
        "internal",
        {
          accountId: Id<"accounts">;
          config: any;
          description?: string;
          name: string;
        },
        Id<"workspaceConfigs">
      >;
      getById: FunctionReference<
        "query",
        "internal",
        { accountId: Id<"accounts">; workspaceId: string },
        {
          _creationTime: number;
          _id: Id<"workspaceConfigs">;
          accountId: Id<"accounts">;
          config: any;
          createdAt: number;
          description?: string;
          managedBy?: "cli" | "dashboard" | "api";
          name: string;
          projectId?: Id<"projects">;
          r2AccessKeyEnv?: string;
          r2SecretAccessKeyEnv?: string;
          stageId?: Id<"stages">;
          updatedAt: number;
        } | null
      >;
      list: FunctionReference<
        "query",
        "internal",
        { accountId: Id<"accounts"> },
        Array<{
          _creationTime: number;
          _id: Id<"workspaceConfigs">;
          accountId: Id<"accounts">;
          config: any;
          createdAt: number;
          description?: string;
          managedBy?: "cli" | "dashboard" | "api";
          name: string;
          projectId?: Id<"projects">;
          r2AccessKeyEnv?: string;
          r2SecretAccessKeyEnv?: string;
          stageId?: Id<"stages">;
          updatedAt: number;
        }>
      >;
      listPage: FunctionReference<
        "query",
        "internal",
        {
          accountId: Id<"accounts">;
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            _creationTime: number;
            _id: Id<"workspaceConfigs">;
            accountId: Id<"accounts">;
            config: any;
            createdAt: number;
            description?: string;
            managedBy?: "cli" | "dashboard" | "api";
            name: string;
            projectId?: Id<"projects">;
            r2AccessKeyEnv?: string;
            r2SecretAccessKeyEnv?: string;
            stageId?: Id<"stages">;
            updatedAt: number;
          }>;
          pageStatus?: "SplitRecommended" | "SplitRequired" | null;
          splitCursor?: string | null;
        }
      >;
      listStorageRuleViolations: FunctionReference<
        "query",
        "internal",
        {
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
        },
        {
          continueCursor: string;
          isDone: boolean;
          violations: Array<{
            accountId: Id<"accounts">;
            bucket?: string;
            name: string;
            reason: string;
            workspaceId: Id<"workspaceConfigs">;
          }>;
        }
      >;
      r2Credentials: FunctionReference<
        "mutation",
        "internal",
        { accountId: string; prefix: string; workspaceId: string },
        {
          accessKeyId: string;
          expiration: string;
          secretAccessKey: string;
          sessionToken: string;
        }
      >;
      remove: FunctionReference<
        "mutation",
        "internal",
        { accountId: Id<"accounts">; workspaceId: string },
        null
      >;
      update: FunctionReference<
        "mutation",
        "internal",
        {
          accountId: Id<"accounts">;
          config?: any;
          description?: string;
          name?: string;
          workspaceId: string;
        },
        null
      >;
    };
    files: {
      createDownloadToken: FunctionReference<
        "mutation",
        "internal",
        {
          accountId: Id<"accounts">;
          expiresAt: number;
          filename: string;
          now: number;
          path: string;
          tokenHash: string;
          workspaceId: Id<"workspaceConfigs">;
        },
        null
      >;
      resolveByHash: FunctionReference<
        "query",
        "internal",
        { now: number; tokenHash: string },
        {
          accountId: Id<"accounts">;
          expiresAt: number;
          filename: string;
          path: string;
          workspaceId: Id<"workspaceConfigs">;
        } | null
      >;
      resolveRuntimeWorkspaceInternal: FunctionReference<
        "query",
        "internal",
        {
          authId: string;
          projectId: Id<"projects">;
          requiredRole?: "owner" | "admin" | "member";
          workspaceId: string;
        },
        {
          accountId: Id<"accounts">;
          storage: {
            auth?:
              | { type: "managed" }
              | { accessKeyId: string; secretAccessKey: string; type: "r2" }
              | { roleArn: string; type: "assumeRole" };
            bucket?: string;
            endpoint?: string;
            prefix?: string;
            provider: "s3";
            region?: string;
          };
          workspaceId: Id<"workspaceConfigs">;
        } | null
      >;
    };
  };
};

export declare const components: {
  workOSAuthKit: import("@convex-dev/workos-authkit/_generated/component.js").ComponentApi<"workOSAuthKit">;
  stripe: import("@convex-dev/stripe/_generated/component.js").ComponentApi<"stripe">;
  crons: import("@convex-dev/crons/_generated/component.js").ComponentApi<"crons">;
};
