/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as accountEnvVars from "../accountEnvVars.js";
import type * as accountHooks from "../accountHooks.js";
import type * as accountTools from "../accountTools.js";
import type * as accounts from "../accounts.js";
import type * as agentConfig from "../agentConfig.js";
import type * as agentDeployments from "../agentDeployments.js";
import type * as agentPolicies from "../agentPolicies.js";
import type * as agents from "../agents.js";
import type * as asyncResults from "../asyncResults.js";
import type * as auth from "../auth.js";
import type * as awsBundles from "../awsBundles.js";
import type * as awsCrons from "../awsCrons.js";
import type * as awsSkills from "../awsSkills.js";
import type * as awsWorkspaceFiles from "../awsWorkspaceFiles.js";
import type * as canvas from "../canvas.js";
import type * as cliAuth from "../cliAuth.js";
import type * as cliAuthHttp from "../cliAuthHttp.js";
import type * as cliHttp from "../cliHttp.js";
import type * as cliOnboardingHttp from "../cliOnboardingHttp.js";
import type * as cliSync from "../cliSync.js";
import type * as cliTypes from "../cliTypes.js";
import type * as configAuditEvents from "../configAuditEvents.js";
import type * as configHttp from "../configHttp.js";
import type * as configHttpAuthFailures from "../configHttpAuthFailures.js";
import type * as conversations from "../conversations.js";
import type * as cron from "../cron.js";
import type * as cronPublic from "../cronPublic.js";
import type * as crons from "../crons.js";
import type * as deployKeys from "../deployKeys.js";
import type * as environment from "../environment.js";
import type * as environmentVariables from "../environmentVariables.js";
import type * as http from "../http.js";
import type * as lib_slug from "../lib/slug.js";
import type * as logs from "../logs.js";
import type * as logsHelpers from "../logsHelpers.js";
import type * as messages from "../messages.js";
import type * as migrations from "../migrations.js";
import type * as model_accountHooks from "../model/accountHooks.js";
import type * as model_accountSecrets from "../model/accountSecrets.js";
import type * as model_accountTools from "../model/accountTools.js";
import type * as model_agentConfigCodec from "../model/agentConfigCodec.js";
import type * as model_agentRules from "../model/agentRules.js";
import type * as model_agentRuntimeSecrets from "../model/agentRuntimeSecrets.js";
import type * as model_agentSync from "../model/agentSync.js";
import type * as model_auditEvents from "../model/auditEvents.js";
import type * as model_aws from "../model/aws.js";
import type * as model_cascade from "../model/cascade.js";
import type * as model_configValues from "../model/configValues.js";
import type * as model_cronRules from "../model/cronRules.js";
import type * as model_environmentValues from "../model/environmentValues.js";
import type * as model_objects from "../model/objects.js";
import type * as model_ownership_environment from "../model/ownership/environment.js";
import type * as model_ownership_org from "../model/ownership/org.js";
import type * as model_ownership_project from "../model/ownership/project.js";
import type * as model_policyRules from "../model/policyRules.js";
import type * as model_s3 from "../model/s3.js";
import type * as model_sandboxConfigSync from "../model/sandboxConfigSync.js";
import type * as model_sandboxRules from "../model/sandboxRules.js";
import type * as model_skillRules from "../model/skillRules.js";
import type * as model_skills from "../model/skills.js";
import type * as model_workspaceFs from "../model/workspaceFs.js";
import type * as model_workspaceRules from "../model/workspaceRules.js";
import type * as modelPricing from "../modelPricing.js";
import type * as org from "../org.js";
import type * as orgLifecycle from "../orgLifecycle.js";
import type * as orgMembers from "../orgMembers.js";
import type * as project from "../project.js";
import type * as sandboxAuditEvents from "../sandboxAuditEvents.js";
import type * as sandboxConfigs from "../sandboxConfigs.js";
import type * as sandboxInstances from "../sandboxInstances.js";
import type * as sandboxPublic from "../sandboxPublic.js";
import type * as sandboxSnapshots from "../sandboxSnapshots.js";
import type * as skills from "../skills.js";
import type * as skillsPublic from "../skillsPublic.js";
import type * as stripe from "../stripe.js";
import type * as toolService from "../toolService.js";
import type * as usage from "../usage.js";
import type * as user from "../user.js";
import type * as webhooks from "../webhooks.js";
import type * as workosUserDeletion from "../workosUserDeletion.js";
import type * as workosUserDeletionCleanup from "../workosUserDeletionCleanup.js";
import type * as workspaceConfigs from "../workspaceConfigs.js";
import type * as workspaceFiles from "../workspaceFiles.js";
import type * as workspaceFilesPublic from "../workspaceFilesPublic.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  accountEnvVars: typeof accountEnvVars;
  accountHooks: typeof accountHooks;
  accountTools: typeof accountTools;
  accounts: typeof accounts;
  agentConfig: typeof agentConfig;
  agentDeployments: typeof agentDeployments;
  agentPolicies: typeof agentPolicies;
  agents: typeof agents;
  asyncResults: typeof asyncResults;
  auth: typeof auth;
  awsBundles: typeof awsBundles;
  awsCrons: typeof awsCrons;
  awsSkills: typeof awsSkills;
  awsWorkspaceFiles: typeof awsWorkspaceFiles;
  canvas: typeof canvas;
  cliAuth: typeof cliAuth;
  cliAuthHttp: typeof cliAuthHttp;
  cliHttp: typeof cliHttp;
  cliOnboardingHttp: typeof cliOnboardingHttp;
  cliSync: typeof cliSync;
  cliTypes: typeof cliTypes;
  configAuditEvents: typeof configAuditEvents;
  configHttp: typeof configHttp;
  configHttpAuthFailures: typeof configHttpAuthFailures;
  conversations: typeof conversations;
  cron: typeof cron;
  cronPublic: typeof cronPublic;
  crons: typeof crons;
  deployKeys: typeof deployKeys;
  environment: typeof environment;
  environmentVariables: typeof environmentVariables;
  http: typeof http;
  "lib/slug": typeof lib_slug;
  logs: typeof logs;
  logsHelpers: typeof logsHelpers;
  messages: typeof messages;
  migrations: typeof migrations;
  "model/accountHooks": typeof model_accountHooks;
  "model/accountSecrets": typeof model_accountSecrets;
  "model/accountTools": typeof model_accountTools;
  "model/agentConfigCodec": typeof model_agentConfigCodec;
  "model/agentRules": typeof model_agentRules;
  "model/agentRuntimeSecrets": typeof model_agentRuntimeSecrets;
  "model/agentSync": typeof model_agentSync;
  "model/auditEvents": typeof model_auditEvents;
  "model/aws": typeof model_aws;
  "model/cascade": typeof model_cascade;
  "model/configValues": typeof model_configValues;
  "model/cronRules": typeof model_cronRules;
  "model/environmentValues": typeof model_environmentValues;
  "model/objects": typeof model_objects;
  "model/ownership/environment": typeof model_ownership_environment;
  "model/ownership/org": typeof model_ownership_org;
  "model/ownership/project": typeof model_ownership_project;
  "model/policyRules": typeof model_policyRules;
  "model/s3": typeof model_s3;
  "model/sandboxConfigSync": typeof model_sandboxConfigSync;
  "model/sandboxRules": typeof model_sandboxRules;
  "model/skillRules": typeof model_skillRules;
  "model/skills": typeof model_skills;
  "model/workspaceFs": typeof model_workspaceFs;
  "model/workspaceRules": typeof model_workspaceRules;
  modelPricing: typeof modelPricing;
  org: typeof org;
  orgLifecycle: typeof orgLifecycle;
  orgMembers: typeof orgMembers;
  project: typeof project;
  sandboxAuditEvents: typeof sandboxAuditEvents;
  sandboxConfigs: typeof sandboxConfigs;
  sandboxInstances: typeof sandboxInstances;
  sandboxPublic: typeof sandboxPublic;
  sandboxSnapshots: typeof sandboxSnapshots;
  skills: typeof skills;
  skillsPublic: typeof skillsPublic;
  stripe: typeof stripe;
  toolService: typeof toolService;
  usage: typeof usage;
  user: typeof user;
  webhooks: typeof webhooks;
  workosUserDeletion: typeof workosUserDeletion;
  workosUserDeletionCleanup: typeof workosUserDeletionCleanup;
  workspaceConfigs: typeof workspaceConfigs;
  workspaceFiles: typeof workspaceFiles;
  workspaceFilesPublic: typeof workspaceFilesPublic;
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
};
