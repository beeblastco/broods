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
import type * as auth from "../auth.js";
import type * as canvas from "../canvas.js";
import type * as environment from "../environment.js";
import type * as http from "../http.js";
import type * as lib_slug from "../lib/slug.js";
import type * as logs from "../logs.js";
import type * as logsHelpers from "../logsHelpers.js";
import type * as model_ownership_environment from "../model/ownership/environment.js";
import type * as model_ownership_project from "../model/ownership/project.js";
import type * as project from "../project.js";
import type * as stripe from "../stripe.js";
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
  auth: typeof auth;
  canvas: typeof canvas;
  environment: typeof environment;
  http: typeof http;
  "lib/slug": typeof lib_slug;
  logs: typeof logs;
  logsHelpers: typeof logsHelpers;
  "model/ownership/environment": typeof model_ownership_environment;
  "model/ownership/project": typeof model_ownership_project;
  project: typeof project;
  stripe: typeof stripe;
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

export declare const components: {
  workOSAuthKit: import("@convex-dev/workos-authkit/_generated/component.js").ComponentApi<"workOSAuthKit">;
  stripe: import("@convex-dev/stripe/_generated/component.js").ComponentApi<"stripe">;
};
