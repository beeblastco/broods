/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as account_accounts from "../account/accounts.js";
import type * as account_envVars from "../account/envVars.js";
import type * as account_hooks from "../account/hooks.js";
import type * as account_mcp from "../account/mcp.js";
import type * as account_roles from "../account/roles.js";
import type * as account_tools from "../account/tools.js";
import type * as agent_agents from "../agent/agents.js";
import type * as agent_config from "../agent/config.js";
import type * as agent_crons from "../agent/crons.js";
import type * as agent_cronsPublic from "../agent/cronsPublic.js";
import type * as agent_deployments from "../agent/deployments.js";
import type * as agent_policies from "../agent/policies.js";
import type * as auth from "../auth.js";
import type * as aws_bundles from "../aws/bundles.js";
import type * as aws_skills from "../aws/skills.js";
import type * as aws_workspaceFiles from "../aws/workspaceFiles.js";
import type * as canvas from "../canvas.js";
import type * as channel_connections from "../channel/connections.js";
import type * as channel_records from "../channel/records.js";
import type * as cli_auth from "../cli/auth.js";
import type * as cli_http from "../cli/http.js";
import type * as cli_httpRoutes from "../cli/httpRoutes.js";
import type * as cli_projects from "../cli/projects.js";
import type * as cli_stages from "../cli/stages.js";
import type * as cli_sync from "../cli/sync.js";
import type * as cli_types from "../cli/types.js";
import type * as config_auditEvents from "../config/auditEvents.js";
import type * as config_http from "../config/http.js";
import type * as config_routes_accounts from "../config/routes/accounts.js";
import type * as config_routes_agents from "../config/routes/agents.js";
import type * as config_routes_channels from "../config/routes/channels.js";
import type * as config_routes_crons from "../config/routes/crons.js";
import type * as config_routes_envVars from "../config/routes/envVars.js";
import type * as config_routes_hooks from "../config/routes/hooks.js";
import type * as config_routes_mcp from "../config/routes/mcp.js";
import type * as config_routes_policies from "../config/routes/policies.js";
import type * as config_routes_roles from "../config/routes/roles.js";
import type * as config_routes_sandboxes from "../config/routes/sandboxes.js";
import type * as config_routes_shared from "../config/routes/shared.js";
import type * as config_routes_skills from "../config/routes/skills.js";
import type * as config_routes_tools from "../config/routes/tools.js";
import type * as config_routes_workspaceFiles from "../config/routes/workspaceFiles.js";
import type * as config_routes_workspaces from "../config/routes/workspaces.js";
import type * as crons from "../crons.js";
import type * as deployKeys from "../deployKeys.js";
import type * as environmentVariables from "../environmentVariables.js";
import type * as http from "../http.js";
import type * as lib_slug from "../lib/slug.js";
import type * as logs from "../logs.js";
import type * as mcp from "../mcp.js";
import type * as migrations from "../migrations.js";
import type * as model_accountHooks from "../model/accountHooks.js";
import type * as model_accountSecrets from "../model/accountSecrets.js";
import type * as model_accountTools from "../model/accountTools.js";
import type * as model_agentConfigCodec from "../model/agentConfigCodec.js";
import type * as model_agentRules from "../model/agentRules.js";
import type * as model_agentRuntimeSecrets from "../model/agentRuntimeSecrets.js";
import type * as model_agentSync from "../model/agentSync.js";
import type * as model_apiAuthorization from "../model/apiAuthorization.js";
import type * as model_apiCanvasSync from "../model/apiCanvasSync.js";
import type * as model_auditEvents from "../model/auditEvents.js";
import type * as model_aws from "../model/aws.js";
import type * as model_bundles from "../model/bundles.js";
import type * as model_cascade from "../model/cascade.js";
import type * as model_channelEndpoints from "../model/channelEndpoints.js";
import type * as model_channelRules from "../model/channelRules.js";
import type * as model_cliSync from "../model/cliSync.js";
import type * as model_cliSyncCanvas from "../model/cliSyncCanvas.js";
import type * as model_cliSyncChannels from "../model/cliSyncChannels.js";
import type * as model_cliSyncManifest from "../model/cliSyncManifest.js";
import type * as model_cliSyncResources from "../model/cliSyncResources.js";
import type * as model_configValues from "../model/configValues.js";
import type * as model_cronRules from "../model/cronRules.js";
import type * as model_envRefs from "../model/envRefs.js";
import type * as model_environmentValues from "../model/environmentValues.js";
import type * as model_mcp from "../model/mcp.js";
import type * as model_modelPricing from "../model/modelPricing.js";
import type * as model_modelProviders from "../model/modelProviders.js";
import type * as model_objects from "../model/objects.js";
import type * as model_ownership_org from "../model/ownership/org.js";
import type * as model_ownership_project from "../model/ownership/project.js";
import type * as model_ownership_stage from "../model/ownership/stage.js";
import type * as model_policyRules from "../model/policyRules.js";
import type * as model_projectScope from "../model/projectScope.js";
import type * as model_responses from "../model/responses.js";
import type * as model_roleRules from "../model/roleRules.js";
import type * as model_s3 from "../model/s3.js";
import type * as model_sandboxConfigSync from "../model/sandboxConfigSync.js";
import type * as model_sandboxRules from "../model/sandboxRules.js";
import type * as model_serviceBridge from "../model/serviceBridge.js";
import type * as model_skillRules from "../model/skillRules.js";
import type * as model_skills from "../model/skills.js";
import type * as model_slackDirectory from "../model/slackDirectory.js";
import type * as model_usageEndpoints from "../model/usageEndpoints.js";
import type * as model_workspaceFs from "../model/workspaceFs.js";
import type * as model_workspaceRules from "../model/workspaceRules.js";
import type * as org_lifecycle from "../org/lifecycle.js";
import type * as org_members from "../org/members.js";
import type * as org_orgs from "../org/orgs.js";
import type * as org_workosUserDeletion from "../org/workosUserDeletion.js";
import type * as org_workosUserDeletionCleanup from "../org/workosUserDeletionCleanup.js";
import type * as project from "../project.js";
import type * as runtime from "../runtime.js";
import type * as runtimeIngress from "../runtimeIngress.js";
import type * as sandbox_auditEvents from "../sandbox/auditEvents.js";
import type * as sandbox_configs from "../sandbox/configs.js";
import type * as sandbox_instances from "../sandbox/instances.js";
import type * as sandbox_public from "../sandbox/public.js";
import type * as sandbox_snapshots from "../sandbox/snapshots.js";
import type * as skillsPublic from "../skillsPublic.js";
import type * as stage from "../stage.js";
import type * as stripe from "../stripe.js";
import type * as usage from "../usage.js";
import type * as user from "../user.js";
import type * as webhooks from "../webhooks.js";
import type * as workspace_configs from "../workspace/configs.js";
import type * as workspace_files from "../workspace/files.js";
import type * as workspace_filesPublic from "../workspace/filesPublic.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "account/accounts": typeof account_accounts;
  "account/envVars": typeof account_envVars;
  "account/hooks": typeof account_hooks;
  "account/mcp": typeof account_mcp;
  "account/roles": typeof account_roles;
  "account/tools": typeof account_tools;
  "agent/agents": typeof agent_agents;
  "agent/config": typeof agent_config;
  "agent/crons": typeof agent_crons;
  "agent/cronsPublic": typeof agent_cronsPublic;
  "agent/deployments": typeof agent_deployments;
  "agent/policies": typeof agent_policies;
  auth: typeof auth;
  "aws/bundles": typeof aws_bundles;
  "aws/skills": typeof aws_skills;
  "aws/workspaceFiles": typeof aws_workspaceFiles;
  canvas: typeof canvas;
  "channel/connections": typeof channel_connections;
  "channel/records": typeof channel_records;
  "cli/auth": typeof cli_auth;
  "cli/http": typeof cli_http;
  "cli/httpRoutes": typeof cli_httpRoutes;
  "cli/projects": typeof cli_projects;
  "cli/stages": typeof cli_stages;
  "cli/sync": typeof cli_sync;
  "cli/types": typeof cli_types;
  "config/auditEvents": typeof config_auditEvents;
  "config/http": typeof config_http;
  "config/routes/accounts": typeof config_routes_accounts;
  "config/routes/agents": typeof config_routes_agents;
  "config/routes/channels": typeof config_routes_channels;
  "config/routes/crons": typeof config_routes_crons;
  "config/routes/envVars": typeof config_routes_envVars;
  "config/routes/hooks": typeof config_routes_hooks;
  "config/routes/mcp": typeof config_routes_mcp;
  "config/routes/policies": typeof config_routes_policies;
  "config/routes/roles": typeof config_routes_roles;
  "config/routes/sandboxes": typeof config_routes_sandboxes;
  "config/routes/shared": typeof config_routes_shared;
  "config/routes/skills": typeof config_routes_skills;
  "config/routes/tools": typeof config_routes_tools;
  "config/routes/workspaceFiles": typeof config_routes_workspaceFiles;
  "config/routes/workspaces": typeof config_routes_workspaces;
  crons: typeof crons;
  deployKeys: typeof deployKeys;
  environmentVariables: typeof environmentVariables;
  http: typeof http;
  "lib/slug": typeof lib_slug;
  logs: typeof logs;
  mcp: typeof mcp;
  migrations: typeof migrations;
  "model/accountHooks": typeof model_accountHooks;
  "model/accountSecrets": typeof model_accountSecrets;
  "model/accountTools": typeof model_accountTools;
  "model/agentConfigCodec": typeof model_agentConfigCodec;
  "model/agentRules": typeof model_agentRules;
  "model/agentRuntimeSecrets": typeof model_agentRuntimeSecrets;
  "model/agentSync": typeof model_agentSync;
  "model/apiAuthorization": typeof model_apiAuthorization;
  "model/apiCanvasSync": typeof model_apiCanvasSync;
  "model/auditEvents": typeof model_auditEvents;
  "model/aws": typeof model_aws;
  "model/bundles": typeof model_bundles;
  "model/cascade": typeof model_cascade;
  "model/channelEndpoints": typeof model_channelEndpoints;
  "model/channelRules": typeof model_channelRules;
  "model/cliSync": typeof model_cliSync;
  "model/cliSyncCanvas": typeof model_cliSyncCanvas;
  "model/cliSyncChannels": typeof model_cliSyncChannels;
  "model/cliSyncManifest": typeof model_cliSyncManifest;
  "model/cliSyncResources": typeof model_cliSyncResources;
  "model/configValues": typeof model_configValues;
  "model/cronRules": typeof model_cronRules;
  "model/envRefs": typeof model_envRefs;
  "model/environmentValues": typeof model_environmentValues;
  "model/mcp": typeof model_mcp;
  "model/modelPricing": typeof model_modelPricing;
  "model/modelProviders": typeof model_modelProviders;
  "model/objects": typeof model_objects;
  "model/ownership/org": typeof model_ownership_org;
  "model/ownership/project": typeof model_ownership_project;
  "model/ownership/stage": typeof model_ownership_stage;
  "model/policyRules": typeof model_policyRules;
  "model/projectScope": typeof model_projectScope;
  "model/responses": typeof model_responses;
  "model/roleRules": typeof model_roleRules;
  "model/s3": typeof model_s3;
  "model/sandboxConfigSync": typeof model_sandboxConfigSync;
  "model/sandboxRules": typeof model_sandboxRules;
  "model/serviceBridge": typeof model_serviceBridge;
  "model/skillRules": typeof model_skillRules;
  "model/skills": typeof model_skills;
  "model/slackDirectory": typeof model_slackDirectory;
  "model/usageEndpoints": typeof model_usageEndpoints;
  "model/workspaceFs": typeof model_workspaceFs;
  "model/workspaceRules": typeof model_workspaceRules;
  "org/lifecycle": typeof org_lifecycle;
  "org/members": typeof org_members;
  "org/orgs": typeof org_orgs;
  "org/workosUserDeletion": typeof org_workosUserDeletion;
  "org/workosUserDeletionCleanup": typeof org_workosUserDeletionCleanup;
  project: typeof project;
  runtime: typeof runtime;
  runtimeIngress: typeof runtimeIngress;
  "sandbox/auditEvents": typeof sandbox_auditEvents;
  "sandbox/configs": typeof sandbox_configs;
  "sandbox/instances": typeof sandbox_instances;
  "sandbox/public": typeof sandbox_public;
  "sandbox/snapshots": typeof sandbox_snapshots;
  skillsPublic: typeof skillsPublic;
  stage: typeof stage;
  stripe: typeof stripe;
  usage: typeof usage;
  user: typeof user;
  webhooks: typeof webhooks;
  "workspace/configs": typeof workspace_configs;
  "workspace/files": typeof workspace_files;
  "workspace/filesPublic": typeof workspace_filesPublic;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  workOSAuthKit: import("@convex-dev/workos-authkit/_generated/component.js").ComponentApi<"workOSAuthKit">;
  stripe: import("@convex-dev/stripe/_generated/component.js").ComponentApi<"stripe">;
  crons: import("@convex-dev/crons/_generated/component.js").ComponentApi<"crons">;
};
