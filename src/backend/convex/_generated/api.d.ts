/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agent from "../agent.js";
import type * as agents from "../agents.js";
import type * as auth from "../auth.js";
import type * as chat from "../chat.js";
import type * as crypto from "../crypto.js";
import type * as http from "../http.js";
import type * as lib from "../lib.js";
import type * as memory from "../memory.js";
import type * as memoryOps from "../memoryOps.js";
import type * as plugins from "../plugins.js";
import type * as preferences from "../preferences.js";
import type * as skills from "../skills.js";
import type * as workspace from "../workspace.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agent: typeof agent;
  agents: typeof agents;
  auth: typeof auth;
  chat: typeof chat;
  crypto: typeof crypto;
  http: typeof http;
  lib: typeof lib;
  memory: typeof memory;
  memoryOps: typeof memoryOps;
  plugins: typeof plugins;
  preferences: typeof preferences;
  skills: typeof skills;
  workspace: typeof workspace;
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
