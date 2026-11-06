import type { Id } from "../_generated/dataModel";

/**
 * 128-bit non-cryptographic hash (cyrb128). Idempotency is not a security boundary: what matters is that
 * identical inputs always agree and that a changed input all but never collides, at 2^-128 odds.
 * Synchronous and dependency-free so it behaves identically in a mutation, a test and the edge runtime.
 */
function cyrb128(str: string): string {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0].map((n) => n.toString(16).padStart(8, "0")).join("");
}

export type StageInputs = {
  /** Every claim the stage read. Order does not matter: the set is what identifies the input. */
  claimIds: Id<"claims">[];
  icpVersionId: Id<"icpDefinitions"> | null | undefined;
  scoringModelId: Id<"scoringModels"> | null | undefined;
  /** Anything else the stage reads that the three above do not cover (signal ids, a scoreRun id, the stage's logic version). */
  extra?: string[];
};

/**
 * The idempotency key for one stage over one subject: a function of what the stage READS, nothing else. The same
 * claims under the same ICP and model hash the same however many times, in whatever order they were listed; a new
 * claim, a new ICP version, a new model or any `extra` changes it. Each part is length-delimited so that no two
 * different inputs can serialise to the same string.
 */
export function stageInputHash(inputs: StageInputs): string {
  const part = (label: string, values: readonly string[]) => `${label}:${values.length}:${values.map((x) => `${x.length}=${x}`).join("|")}`;
  const claimIds = [...new Set(inputs.claimIds as string[])].sort();
  const extra = [...(inputs.extra ?? [])].sort();
  return cyrb128(
    [part("claims", claimIds), part("icp", [inputs.icpVersionId ?? "none"]), part("model", [inputs.scoringModelId ?? "none"]), part("extra", extra)].join("\n"),
  );
}
