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
import type * as automationOps from "../automationOps.js";
import type * as automationRuns from "../automationRuns.js";
import type * as automationTools from "../automationTools.js";
import type * as automations from "../automations.js";
import type * as cascade from "../cascade.js";
import type * as chatOps from "../chatOps.js";
import type * as chatTools from "../chatTools.js";
import type * as chats from "../chats.js";
import type * as connectorTools from "../connectorTools.js";
import type * as connectors from "../connectors.js";
import type * as crons from "../crons.js";
import type * as crypto from "../crypto.js";
import type * as databaseViews from "../databaseViews.js";
import type * as dictation from "../dictation.js";
import type * as fields from "../fields.js";
import type * as fileText from "../fileText.js";
import type * as files from "../files.js";
import type * as functions from "../functions.js";
import type * as http from "../http.js";
import type * as imageGen from "../imageGen.js";
import type * as images from "../images.js";
import type * as invites from "../invites.js";
import type * as lib from "../lib.js";
import type * as lifecycle from "../lifecycle.js";
import type * as linkPreviews from "../linkPreviews.js";
import type * as linkUnfurl from "../linkUnfurl.js";
import type * as manageTools from "../manageTools.js";
import type * as memory from "../memory.js";
import type * as memoryOps from "../memoryOps.js";
import type * as messages from "../messages.js";
import type * as migrations from "../migrations.js";
import type * as modelCatalog from "../modelCatalog.js";
import type * as oauth from "../oauth.js";
import type * as onboarding from "../onboarding.js";
import type * as pageBlocks from "../pageBlocks.js";
import type * as pageMarkdown from "../pageMarkdown.js";
import type * as pageOps from "../pageOps.js";
import type * as pageSync from "../pageSync.js";
import type * as pageTools from "../pageTools.js";
import type * as pageTree from "../pageTree.js";
import type * as pages from "../pages.js";
import type * as parity from "../parity.js";
import type * as permissions from "../permissions.js";
import type * as preferences from "../preferences.js";
import type * as recordOps from "../recordOps.js";
import type * as recordQuery from "../recordQuery.js";
import type * as recordReads from "../recordReads.js";
import type * as recordTools from "../recordTools.js";
import type * as recordTypes from "../recordTypes.js";
import type * as recordValidators from "../recordValidators.js";
import type * as records from "../records.js";
import type * as router from "../router.js";
import type * as skills from "../skills.js";
import type * as trash from "../trash.js";
import type * as trashOps from "../trashOps.js";
import type * as turns from "../turns.js";
import type * as typing from "../typing.js";
import type * as usage from "../usage.js";
import type * as wakeups from "../wakeups.js";
import type * as webFetch from "../webFetch.js";
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
  automationOps: typeof automationOps;
  automationRuns: typeof automationRuns;
  automationTools: typeof automationTools;
  automations: typeof automations;
  cascade: typeof cascade;
  chatOps: typeof chatOps;
  chatTools: typeof chatTools;
  chats: typeof chats;
  connectorTools: typeof connectorTools;
  connectors: typeof connectors;
  crons: typeof crons;
  crypto: typeof crypto;
  databaseViews: typeof databaseViews;
  dictation: typeof dictation;
  fields: typeof fields;
  fileText: typeof fileText;
  files: typeof files;
  functions: typeof functions;
  http: typeof http;
  imageGen: typeof imageGen;
  images: typeof images;
  invites: typeof invites;
  lib: typeof lib;
  lifecycle: typeof lifecycle;
  linkPreviews: typeof linkPreviews;
  linkUnfurl: typeof linkUnfurl;
  manageTools: typeof manageTools;
  memory: typeof memory;
  memoryOps: typeof memoryOps;
  messages: typeof messages;
  migrations: typeof migrations;
  modelCatalog: typeof modelCatalog;
  oauth: typeof oauth;
  onboarding: typeof onboarding;
  pageBlocks: typeof pageBlocks;
  pageMarkdown: typeof pageMarkdown;
  pageOps: typeof pageOps;
  pageSync: typeof pageSync;
  pageTools: typeof pageTools;
  pageTree: typeof pageTree;
  pages: typeof pages;
  parity: typeof parity;
  permissions: typeof permissions;
  preferences: typeof preferences;
  recordOps: typeof recordOps;
  recordQuery: typeof recordQuery;
  recordReads: typeof recordReads;
  recordTools: typeof recordTools;
  recordTypes: typeof recordTypes;
  recordValidators: typeof recordValidators;
  records: typeof records;
  router: typeof router;
  skills: typeof skills;
  trash: typeof trash;
  trashOps: typeof trashOps;
  turns: typeof turns;
  typing: typeof typing;
  usage: typeof usage;
  wakeups: typeof wakeups;
  webFetch: typeof webFetch;
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
  prosemirrorSync: import("@convex-dev/prosemirror-sync/_generated/component.js").ComponentApi<"prosemirrorSync">;
};
