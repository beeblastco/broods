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
import type * as canvas from "../canvas.js";
import type * as environment from "../environment.js";
import type * as model_ownership_agent from "../model/ownership/agent.js";
import type * as model_ownership_environment from "../model/ownership/environment.js";
import type * as model_ownership_index from "../model/ownership/index.js";
import type * as model_ownership_project from "../model/ownership/project.js";
import type * as model_ownership_session from "../model/ownership/session.js";
import type * as model_ownership_user from "../model/ownership/user.js";
import type * as project from "../project.js";
import type * as user from "../user.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agentConfig: typeof agentConfig;
  canvas: typeof canvas;
  environment: typeof environment;
  "model/ownership/agent": typeof model_ownership_agent;
  "model/ownership/environment": typeof model_ownership_environment;
  "model/ownership/index": typeof model_ownership_index;
  "model/ownership/project": typeof model_ownership_project;
  "model/ownership/session": typeof model_ownership_session;
  "model/ownership/user": typeof model_ownership_user;
  project: typeof project;
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
