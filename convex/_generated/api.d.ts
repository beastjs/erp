/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as _shared_normalize from "../_shared/normalize.js";
import type * as _shared_org from "../_shared/org.js";
import type * as claims_mutations from "../claims/mutations.js";
import type * as claims_queries from "../claims/queries.js";
import type * as projections_build from "../projections/build.js";
import type * as projections_identity from "../projections/identity.js";
import type * as projections_queries from "../projections/queries.js";
import type * as projections_resolve from "../projections/resolve.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "_shared/normalize": typeof _shared_normalize;
  "_shared/org": typeof _shared_org;
  "claims/mutations": typeof claims_mutations;
  "claims/queries": typeof claims_queries;
  "projections/build": typeof projections_build;
  "projections/identity": typeof projections_identity;
  "projections/queries": typeof projections_queries;
  "projections/resolve": typeof projections_resolve;
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
