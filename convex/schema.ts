import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { claims } from "./claims/schema";
import { sources, candidates, columnMappings, importChunks, importRejections } from "./sources/schema";
import { discoveryRuns } from "./runs/schema";
import { signals } from "./signals/schema";
import { icpDefinitions, scoringModels } from "./icp/schema";
import { scoreRuns } from "./scoring/schema";
import { leads } from "./leads/schema";
import { pipelineState } from "./pipeline/schema";
import { accounts, contacts, contactKeys, identityLinks } from "./projections/schema";
import { auditLog } from "./audit/schema";
import { memberships } from "./members/schema";
import { erasureSnapshotRefs, erasures, suppressions } from "./privacy/schema";
import { verificationSweeps, verifications } from "./verify/schema";

export default defineSchema({
  claims,
  accounts,
  contacts,
  contactKeys,
  identityLinks,
  orgs: defineTable({
    name: v.string(),
    createdAt: v.number(),
  }),
  sources,
  candidates,
  columnMappings,
  importChunks,
  importRejections,
  discoveryRuns,
  signals,
  icpDefinitions,
  scoringModels,
  scoreRuns,
  leads,
  pipelineState,
  suppressions,
  erasures,
  erasureSnapshotRefs,
  memberships,
  auditLog,
  verifications,
  verificationSweeps,
});
