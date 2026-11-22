/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as account from "../account.js";
import type * as auth from "../auth.js";
import type * as chats from "../chats.js";
import type * as cleanup from "../cleanup.js";
import type * as contacts from "../contacts.js";
import type * as crons from "../crons.js";
import type * as demo from "../demo.js";
import type * as gateway from "../gateway.js";
import type * as google from "../google.js";
import type * as health from "../health.js";
import type * as http from "../http.js";
import type * as keys from "../keys.js";
import type * as labels from "../labels.js";
import type * as lib_access from "../lib/access.js";
import type * as lib_audit from "../lib/audit.js";
import type * as lib_authRows from "../lib/authRows.js";
import type * as lib_bounded from "../lib/bounded.js";
import type * as lib_chatView from "../lib/chatView.js";
import type * as lib_commandOutcome from "../lib/commandOutcome.js";
import type * as lib_envelope from "../lib/envelope.js";
import type * as lib_formerMembers from "../lib/formerMembers.js";
import type * as lib_hash from "../lib/hash.js";
import type * as lib_ingest from "../lib/ingest.js";
import type * as lib_lastMessage from "../lib/lastMessage.js";
import type * as lib_networks from "../lib/networks.js";
import type * as lib_outbox from "../lib/outbox.js";
import type * as lib_passwordReset from "../lib/passwordReset.js";
import type * as lib_retry from "../lib/retry.js";
import type * as lib_seal from "../lib/seal.js";
import type * as lib_send from "../lib/send.js";
import type * as lib_session from "../lib/session.js";
import type * as logins from "../logins.js";
import type * as mcp from "../mcp.js";
import type * as media from "../media.js";
import type * as members from "../members.js";
import type * as messages from "../messages.js";
import type * as migrations from "../migrations.js";
import type * as networks from "../networks.js";
import type * as newChats from "../newChats.js";
import type * as people from "../people.js";
import type * as preferences from "../preferences.js";
import type * as quarantine from "../quarantine.js";
import type * as rateLimits from "../rateLimits.js";
import type * as scheduled from "../scheduled.js";
import type * as server from "../server.js";
import type * as updates from "../updates.js";
import type * as validators from "../validators.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  account: typeof account;
  auth: typeof auth;
  chats: typeof chats;
  cleanup: typeof cleanup;
  contacts: typeof contacts;
  crons: typeof crons;
  demo: typeof demo;
  gateway: typeof gateway;
  google: typeof google;
  health: typeof health;
  http: typeof http;
  keys: typeof keys;
  labels: typeof labels;
  "lib/access": typeof lib_access;
  "lib/audit": typeof lib_audit;
  "lib/authRows": typeof lib_authRows;
  "lib/bounded": typeof lib_bounded;
  "lib/chatView": typeof lib_chatView;
  "lib/commandOutcome": typeof lib_commandOutcome;
  "lib/envelope": typeof lib_envelope;
  "lib/formerMembers": typeof lib_formerMembers;
  "lib/hash": typeof lib_hash;
  "lib/ingest": typeof lib_ingest;
  "lib/lastMessage": typeof lib_lastMessage;
  "lib/networks": typeof lib_networks;
  "lib/outbox": typeof lib_outbox;
  "lib/passwordReset": typeof lib_passwordReset;
  "lib/retry": typeof lib_retry;
  "lib/seal": typeof lib_seal;
  "lib/send": typeof lib_send;
  "lib/session": typeof lib_session;
  logins: typeof logins;
  mcp: typeof mcp;
  media: typeof media;
  members: typeof members;
  messages: typeof messages;
  migrations: typeof migrations;
  networks: typeof networks;
  newChats: typeof newChats;
  people: typeof people;
  preferences: typeof preferences;
  quarantine: typeof quarantine;
  rateLimits: typeof rateLimits;
  scheduled: typeof scheduled;
  server: typeof server;
  updates: typeof updates;
  validators: typeof validators;
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
  betterAuth: import("../betterAuth/_generated/component.js").ComponentApi<"betterAuth">;
  mcp: import("@convex-dev/mcp/_generated/component.js").ComponentApi<"mcp">;
};
