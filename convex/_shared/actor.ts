import { v } from "convex/values";

/** Spec 7.1. Ordered by privilege: each role may do everything the ones before it may. */
export const ROLES = ["operator", "analyst", "admin"] as const;
export type Role = (typeof ROLES)[number];
export const role = v.union(v.literal("operator"), v.literal("analyst"), v.literal("admin"));

/**
 * The closed set of things that act with NO human behind them. Adding one is a decision to review: every system
 * actor in the log is one of these, so "what did the system do on its own" is a finite question.
 */
export const SYSTEM_PROCESSES = ["default_scoring_model_seed", "erasure", "membership_bootstrap", "lead_supersession"] as const;
export type SystemProcess = (typeof SYSTEM_PROCESSES)[number];

/**
 * WHO did something. A discriminated union, not a string: a person and a process are different KINDS of thing and
 * must never be told apart by recognising a magic value. A scheduled or cron function has no identity, so it has no
 * `user` actor to offer, and the only way to name it is a `system` actor with a process from the closed set above.
 * Nothing in the code base may build a `user` actor except `requireRole` (the role is the one it just verified).
 */
export type Actor = { kind: "user"; userId: string; role: Role } | { kind: "system"; process: SystemProcess };

export const actor = v.union(
  v.object({ kind: v.literal("user"), userId: v.string(), role }),
  v.object({ kind: v.literal("system"), process: v.union(v.literal("default_scoring_model_seed"), v.literal("erasure"), v.literal("membership_bootstrap"), v.literal("lead_supersession")) }),
);
