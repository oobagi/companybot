/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as activity from "../activity.js";
import type * as agent from "../agent.js";
import type * as agents from "../agents.js";
import type * as approvals from "../approvals.js";
import type * as auth from "../auth.js";
import type * as automations from "../automations.js";
import type * as chatOps from "../chatOps.js";
import type * as chats from "../chats.js";
import type * as connectors from "../connectors.js";
import type * as crons from "../crons.js";
import type * as crypto from "../crypto.js";
import type * as http from "../http.js";
import type * as lib from "../lib.js";
import type * as memory from "../memory.js";
import type * as memoryOps from "../memoryOps.js";
import type * as messages from "../messages.js";
import type * as migrations from "../migrations.js";
import type * as oauth from "../oauth.js";
import type * as permissions from "../permissions.js";
import type * as plugins from "../plugins.js";
import type * as preferences from "../preferences.js";
import type * as skills from "../skills.js";
import type * as turns from "../turns.js";
import type * as workspace from "../workspace.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  activity: typeof activity;
  agent: typeof agent;
  agents: typeof agents;
  approvals: typeof approvals;
  auth: typeof auth;
  automations: typeof automations;
  chatOps: typeof chatOps;
  chats: typeof chats;
  connectors: typeof connectors;
  crons: typeof crons;
  crypto: typeof crypto;
  http: typeof http;
  lib: typeof lib;
  memory: typeof memory;
  memoryOps: typeof memoryOps;
  messages: typeof messages;
  migrations: typeof migrations;
  oauth: typeof oauth;
  permissions: typeof permissions;
  plugins: typeof plugins;
  preferences: typeof preferences;
  skills: typeof skills;
  turns: typeof turns;
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

export declare const components: {
  migrations: import("@convex-dev/migrations/_generated/component.js").ComponentApi<"migrations">;
};
