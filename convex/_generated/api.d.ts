/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as _shared_actor from "../_shared/actor.js";
import type * as _shared_authz from "../_shared/authz.js";
import type * as _shared_limits from "../_shared/limits.js";
import type * as _shared_normalize from "../_shared/normalize.js";
import type * as _shared_org from "../_shared/org.js";
import type * as audit_api from "../audit/api.js";
import type * as audit_log from "../audit/log.js";
import type * as claims_mutations from "../claims/mutations.js";
import type * as claims_queries from "../claims/queries.js";
import type * as crons from "../crons.js";
import type * as icp_api from "../icp/api.js";
import type * as icp_defaults from "../icp/defaults.js";
import type * as icp_mutations from "../icp/mutations.js";
import type * as icp_queries from "../icp/queries.js";
import type * as icp_tier from "../icp/tier.js";
import type * as icp_validate from "../icp/validate.js";
import type * as leads_api from "../leads/api.js";
import type * as leads_mutations from "../leads/mutations.js";
import type * as leads_queries from "../leads/queries.js";
import type * as members_api from "../members/api.js";
import type * as observability_definitions from "../observability/definitions.js";
import type * as observability_health from "../observability/health.js";
import type * as observability_quality from "../observability/quality.js";
import type * as observability_refusals from "../observability/refusals.js";
import type * as observability_runs from "../observability/runs.js";
import type * as pipeline_deadletter from "../pipeline/deadletter.js";
import type * as pipeline_hash from "../pipeline/hash.js";
import type * as pipeline_stages from "../pipeline/stages.js";
import type * as privacy_api from "../privacy/api.js";
import type * as privacy_erased from "../privacy/erased.js";
import type * as privacy_normalize from "../privacy/normalize.js";
import type * as privacy_redact from "../privacy/redact.js";
import type * as privacy_suppress from "../privacy/suppress.js";
import type * as privacy_sweep from "../privacy/sweep.js";
import type * as projections_build from "../projections/build.js";
import type * as projections_identity from "../projections/identity.js";
import type * as projections_queries from "../projections/queries.js";
import type * as projections_resolve from "../projections/resolve.js";
import type * as qualify_distributability from "../qualify/distributability.js";
import type * as runs_mutations from "../runs/mutations.js";
import type * as runs_queries from "../runs/queries.js";
import type * as scoring_assemble from "../scoring/assemble.js";
import type * as scoring_mutations from "../scoring/mutations.js";
import type * as scoring_score from "../scoring/score.js";
import type * as signals_decay from "../signals/decay.js";
import type * as signals_mutations from "../signals/mutations.js";
import type * as sources_contract from "../sources/contract.js";
import type * as sources_csv from "../sources/csv.js";
import type * as sources_import from "../sources/import.js";
import type * as sources_ingest from "../sources/ingest.js";
import type * as sources_mapping from "../sources/mapping.js";
import type * as sources_mutations from "../sources/mutations.js";
import type * as sources_xlsx from "../sources/xlsx.js";
import type * as verify_lists from "../verify/lists.js";
import type * as verify_mutations from "../verify/mutations.js";
import type * as verify_structural from "../verify/structural.js";
import type * as verify_sweep from "../verify/sweep.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "_shared/actor": typeof _shared_actor;
  "_shared/authz": typeof _shared_authz;
  "_shared/limits": typeof _shared_limits;
  "_shared/normalize": typeof _shared_normalize;
  "_shared/org": typeof _shared_org;
  "audit/api": typeof audit_api;
  "audit/log": typeof audit_log;
  "claims/mutations": typeof claims_mutations;
  "claims/queries": typeof claims_queries;
  crons: typeof crons;
  "icp/api": typeof icp_api;
  "icp/defaults": typeof icp_defaults;
  "icp/mutations": typeof icp_mutations;
  "icp/queries": typeof icp_queries;
  "icp/tier": typeof icp_tier;
  "icp/validate": typeof icp_validate;
  "leads/api": typeof leads_api;
  "leads/mutations": typeof leads_mutations;
  "leads/queries": typeof leads_queries;
  "members/api": typeof members_api;
  "observability/definitions": typeof observability_definitions;
  "observability/health": typeof observability_health;
  "observability/quality": typeof observability_quality;
  "observability/refusals": typeof observability_refusals;
  "observability/runs": typeof observability_runs;
  "pipeline/deadletter": typeof pipeline_deadletter;
  "pipeline/hash": typeof pipeline_hash;
  "pipeline/stages": typeof pipeline_stages;
  "privacy/api": typeof privacy_api;
  "privacy/erased": typeof privacy_erased;
  "privacy/normalize": typeof privacy_normalize;
  "privacy/redact": typeof privacy_redact;
  "privacy/suppress": typeof privacy_suppress;
  "privacy/sweep": typeof privacy_sweep;
  "projections/build": typeof projections_build;
  "projections/identity": typeof projections_identity;
  "projections/queries": typeof projections_queries;
  "projections/resolve": typeof projections_resolve;
  "qualify/distributability": typeof qualify_distributability;
  "runs/mutations": typeof runs_mutations;
  "runs/queries": typeof runs_queries;
  "scoring/assemble": typeof scoring_assemble;
  "scoring/mutations": typeof scoring_mutations;
  "scoring/score": typeof scoring_score;
  "signals/decay": typeof signals_decay;
  "signals/mutations": typeof signals_mutations;
  "sources/contract": typeof sources_contract;
  "sources/csv": typeof sources_csv;
  "sources/import": typeof sources_import;
  "sources/ingest": typeof sources_ingest;
  "sources/mapping": typeof sources_mapping;
  "sources/mutations": typeof sources_mutations;
  "sources/xlsx": typeof sources_xlsx;
  "verify/lists": typeof verify_lists;
  "verify/mutations": typeof verify_mutations;
  "verify/structural": typeof verify_structural;
  "verify/sweep": typeof verify_sweep;
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
