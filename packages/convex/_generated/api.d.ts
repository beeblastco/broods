/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as accountTools from "../accountTools.js";
import type * as accounts from "../accounts.js";
import type * as agentConfig from "../agentConfig.js";
import type * as agentDeployments from "../agentDeployments.js";
import type * as agents from "../agents.js";
import type * as asyncResults from "../asyncResults.js";
import type * as auth from "../auth.js";
import type * as canvas from "../canvas.js";
import type * as cliAuth from "../cliAuth.js";
import type * as cliAuthHttp from "../cliAuthHttp.js";
import type * as cliHttp from "../cliHttp.js";
import type * as cliOnboardingHttp from "../cliOnboardingHttp.js";
import type * as cliSync from "../cliSync.js";
import type * as cliTypes from "../cliTypes.js";
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
import type * as model_agentConfigCodec from "../model/agentConfigCodec.js";
import type * as model_agentRuntimeSecrets from "../model/agentRuntimeSecrets.js";
import type * as model_agentSync from "../model/agentSync.js";
import type * as model_cascade from "../model/cascade.js";
import type * as model_environmentValues from "../model/environmentValues.js";
import type * as model_objects from "../model/objects.js";
import type * as model_ownership_environment from "../model/ownership/environment.js";
import type * as model_ownership_org from "../model/ownership/org.js";
import type * as model_ownership_project from "../model/ownership/project.js";
import type * as model_sandboxConfigSync from "../model/sandboxConfigSync.js";
import type * as modelPricing from "../modelPricing.js";
import type * as observability from "../observability.js";
import type * as org from "../org.js";
import type * as orgLifecycle from "../orgLifecycle.js";
import type * as orgMembers from "../orgMembers.js";
import type * as project from "../project.js";
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
import type * as workspaceConfigs from "../workspaceConfigs.js";
import type * as workspaceFiles from "../workspaceFiles.js";
import type * as workspaceFilesPublic from "../workspaceFilesPublic.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  accountTools: typeof accountTools;
  accounts: typeof accounts;
  agentConfig: typeof agentConfig;
  agentDeployments: typeof agentDeployments;
  agents: typeof agents;
  asyncResults: typeof asyncResults;
  auth: typeof auth;
  canvas: typeof canvas;
  cliAuth: typeof cliAuth;
  cliAuthHttp: typeof cliAuthHttp;
  cliHttp: typeof cliHttp;
  cliOnboardingHttp: typeof cliOnboardingHttp;
  cliSync: typeof cliSync;
  cliTypes: typeof cliTypes;
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
  "model/agentConfigCodec": typeof model_agentConfigCodec;
  "model/agentRuntimeSecrets": typeof model_agentRuntimeSecrets;
  "model/agentSync": typeof model_agentSync;
  "model/cascade": typeof model_cascade;
  "model/environmentValues": typeof model_environmentValues;
  "model/objects": typeof model_objects;
  "model/ownership/environment": typeof model_ownership_environment;
  "model/ownership/org": typeof model_ownership_org;
  "model/ownership/project": typeof model_ownership_project;
  "model/sandboxConfigSync": typeof model_sandboxConfigSync;
  modelPricing: typeof modelPricing;
  observability: typeof observability;
  org: typeof org;
  orgLifecycle: typeof orgLifecycle;
  orgMembers: typeof orgMembers;
  project: typeof project;
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
