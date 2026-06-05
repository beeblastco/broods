/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as accounts from "../accounts.js";
import type * as agentConfig from "../agentConfig.js";
import type * as agentDeployments from "../agentDeployments.js";
import type * as agents from "../agents.js";
import type * as asyncResults from "../asyncResults.js";
import type * as auth from "../auth.js";
import type * as canvas from "../canvas.js";
import type * as cliHttp from "../cliHttp.js";
import type * as cliSync from "../cliSync.js";
import type * as conversations from "../conversations.js";
import type * as cronJobs from "../cronJobs.js";
import type * as cronJobsPublic from "../cronJobsPublic.js";
import type * as environment from "../environment.js";
import type * as http from "../http.js";
import type * as lib_slug from "../lib/slug.js";
import type * as logs from "../logs.js";
import type * as logsHelpers from "../logsHelpers.js";
import type * as messages from "../messages.js";
import type * as model_agentConfigCodec from "../model/agentConfigCodec.js";
import type * as model_agentSync from "../model/agentSync.js";
import type * as model_ownership_environment from "../model/ownership/environment.js";
import type * as model_ownership_org from "../model/ownership/org.js";
import type * as model_ownership_project from "../model/ownership/project.js";
import type * as org from "../org.js";
import type * as orgLifecycle from "../orgLifecycle.js";
import type * as orgMembers from "../orgMembers.js";
import type * as project from "../project.js";
import type * as sandboxConfigs from "../sandboxConfigs.js";
import type * as skills from "../skills.js";
import type * as stripe from "../stripe.js";
import type * as toolService from "../toolService.js";
import type * as user from "../user.js";
import type * as workspaceConfigs from "../workspaceConfigs.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  accounts: typeof accounts;
  agentConfig: typeof agentConfig;
  agentDeployments: typeof agentDeployments;
  agents: typeof agents;
  asyncResults: typeof asyncResults;
  auth: typeof auth;
  canvas: typeof canvas;
  cliHttp: typeof cliHttp;
  cliSync: typeof cliSync;
  conversations: typeof conversations;
  cronJobs: typeof cronJobs;
  cronJobsPublic: typeof cronJobsPublic;
  environment: typeof environment;
  http: typeof http;
  "lib/slug": typeof lib_slug;
  logs: typeof logs;
  logsHelpers: typeof logsHelpers;
  messages: typeof messages;
  "model/agentConfigCodec": typeof model_agentConfigCodec;
  "model/agentSync": typeof model_agentSync;
  "model/ownership/environment": typeof model_ownership_environment;
  "model/ownership/org": typeof model_ownership_org;
  "model/ownership/project": typeof model_ownership_project;
  org: typeof org;
  orgLifecycle: typeof orgLifecycle;
  orgMembers: typeof orgMembers;
  project: typeof project;
  sandboxConfigs: typeof sandboxConfigs;
  skills: typeof skills;
  stripe: typeof stripe;
  toolService: typeof toolService;
  user: typeof user;
  workspaceConfigs: typeof workspaceConfigs;
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
