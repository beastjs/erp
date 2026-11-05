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
import type * as icp_defaults from "../icp/defaults.js";
import type * as icp_mutations from "../icp/mutations.js";
import type * as icp_queries from "../icp/queries.js";
import type * as icp_tier from "../icp/tier.js";
import type * as icp_validate from "../icp/validate.js";
import type * as projections_build from "../projections/build.js";
import type * as projections_identity from "../projections/identity.js";
import type * as projections_queries from "../projections/queries.js";
import type * as projections_resolve from "../projections/resolve.js";
import type * as runs_mutations from "../runs/mutations.js";
import type * as runs_queries from "../runs/queries.js";
import type * as signals_decay from "../signals/decay.js";
import type * as signals_mutations from "../signals/mutations.js";
import type * as sources_contract from "../sources/contract.js";
import type * as sources_csv from "../sources/csv.js";
import type * as sources_import from "../sources/import.js";
import type * as sources_ingest from "../sources/ingest.js";
import type * as sources_mapping from "../sources/mapping.js";
import type * as sources_mutations from "../sources/mutations.js";
import type * as sources_xlsx from "../sources/xlsx.js";

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
  "icp/defaults": typeof icp_defaults;
  "icp/mutations": typeof icp_mutations;
  "icp/queries": typeof icp_queries;
  "icp/tier": typeof icp_tier;
  "icp/validate": typeof icp_validate;
  "projections/build": typeof projections_build;
  "projections/identity": typeof projections_identity;
  "projections/queries": typeof projections_queries;
  "projections/resolve": typeof projections_resolve;
  "runs/mutations": typeof runs_mutations;
  "runs/queries": typeof runs_queries;
  "signals/decay": typeof signals_decay;
  "signals/mutations": typeof signals_mutations;
  "sources/contract": typeof sources_contract;
  "sources/csv": typeof sources_csv;
  "sources/import": typeof sources_import;
  "sources/ingest": typeof sources_ingest;
  "sources/mapping": typeof sources_mapping;
  "sources/mutations": typeof sources_mutations;
  "sources/xlsx": typeof sources_xlsx;
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
