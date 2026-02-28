/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agentConfig from "../agentConfig.js";
import type * as agentDeployments from "../agentDeployments.js";
import type * as approval from "../approval.js";
import type * as canvas from "../canvas.js";
import type * as crons from "../crons.js";
import type * as environment from "../environment.js";
import type * as http from "../http.js";
import type * as messages from "../messages.js";
import type * as model_agentConfig from "../model/agentConfig.js";
import type * as model_agentDeployment from "../model/agentDeployment.js";
import type * as model_canvas from "../model/canvas.js";
import type * as model_cleanup from "../model/cleanup.js";
import type * as model_gateway from "../model/gateway.js";
import type * as model_messages from "../model/messages.js";
import type * as model_ownership from "../model/ownership.js";
import type * as model_sessions from "../model/sessions.js";
import type * as model_tasks from "../model/tasks.js";
import type * as model_toolService from "../model/toolService.js";
import type * as project from "../project.js";
import type * as sessions from "../sessions.js";
import type * as tasks from "../tasks.js";
import type * as toolService from "../toolService.js";
import type * as user from "../user.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agentConfig: typeof agentConfig;
  agentDeployments: typeof agentDeployments;
  approval: typeof approval;
  canvas: typeof canvas;
  crons: typeof crons;
  environment: typeof environment;
  http: typeof http;
  messages: typeof messages;
  "model/agentConfig": typeof model_agentConfig;
  "model/agentDeployment": typeof model_agentDeployment;
  "model/canvas": typeof model_canvas;
  "model/cleanup": typeof model_cleanup;
  "model/gateway": typeof model_gateway;
  "model/messages": typeof model_messages;
  "model/ownership": typeof model_ownership;
  "model/sessions": typeof model_sessions;
  "model/tasks": typeof model_tasks;
  "model/toolService": typeof model_toolService;
  project: typeof project;
  sessions: typeof sessions;
  tasks: typeof tasks;
  toolService: typeof toolService;
  user: typeof user;
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

export declare const components: {};
