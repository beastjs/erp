import { describe, expect, test } from "vitest";
import type { Doc, Id } from "../_generated/dataModel";
import { resolveField } from "./resolve";

type Claim = Doc<"claims">;

// Default recording time, well after the default observedAt (1000) so claims are not clamped.
const RECORDED = 1_000_000;
const srcA = "srcA" as Id<"sources">;
const srcB = "srcB" as Id<"sources">;
const sources = new Map<Id<"sources">, { trustWeight: number }>([
  [srcA, { trustWeight: 0.5 }],
  [srcB, { trustWeight: 0.9 }],
]);

let seq = 0;
function claim(over: Omit<Partial<Claim>, "_id"> & { _id?: string }): Claim {
  seq += 1;
  return {
    _id: (over._id ?? `c${String(seq).padStart(4, "0")}`) as Id<"claims">,
    _creationTime: RECORDED,
    orgId: "org" as Id<"orgs">,
    subjectType: "account",
    subjectId: "acc1",
    field: "domain",
    value: "x.com",
    sourceId: srcA,
    method: "observed",
    confidence: 0.5,
    observedAt: 1000,
    ...over,
  } as Claim;
}

describe("resolveField", () => {
  test("observed beats extracted beats inferred", () => {
    const inferred = claim({ method: "inferred", sourceId: srcB, confidence: 1, observedAt: 9000 });
    const extracted = claim({ method: "extracted", sourceId: srcB, confidence: 1, observedAt: 9000 });
    const observed = claim({ method: "observed" });
    const r = resolveField([inferred, extracted, observed], sources)!;
    expect(r.winner.method).toBe("observed");
    expect(r.contenders.map((c) => c.method)).toEqual(["observed", "extracted", "inferred"]);
  });

  test("same method: higher source trust weight wins", () => {
    const low = claim({ sourceId: srcA, confidence: 1, observedAt: 9000 });
    const high = claim({ sourceId: srcB });
    expect(resolveField([low, high], sources)!.winner._id).toBe(high._id);
  });

  test("unknown source has zero trust", () => {
    const unknown = claim({ sourceId: "ghost" as Id<"sources"> });
    const known = claim({ sourceId: srcA, observedAt: 1 });
    expect(resolveField([unknown, known], sources)!.winner._id).toBe(known._id);
  });

  test("same method and trust: more recent observedAt wins", () => {
    const old = claim({ observedAt: 100, confidence: 1 });
    const recent = claim({ observedAt: 200 });
    expect(resolveField([old, recent], sources)!.winner._id).toBe(recent._id);
  });

  test("same method, trust and recency: higher confidence wins", () => {
    const lo = claim({ confidence: 0.2 });
    const hi = claim({ confidence: 0.8 });
    expect(resolveField([lo, hi], sources)!.winner._id).toBe(hi._id);
  });

  test("full tie resolves by claim id, deterministically", () => {
    const a = claim({ _id: "aaa" });
    const b = claim({ _id: "bbb" });
    const c = claim({ _id: "ccc" });
    const first = resolveField([a, b, c], sources)!.winner._id;
    const second = resolveField([c, a, b], sources)!.winner._id;
    const third = resolveField([b, c, a], sources)!.winner._id;
    expect(first).toBe("aaa");
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  test("an observedAt after the claim was recorded is clamped to its _creationTime", () => {
    // Half 1: equal recording time, future-dated claim has the higher id. Unclamped it would
    // win on recency; clamped, recency ties and the lower id decides.
    const legit = claim({ _id: "a", observedAt: RECORDED });
    const future = claim({ _id: "b", observedAt: RECORDED + 86_400_000 });
    expect(resolveField([future, legit], sources)!.winner._id).toBe("a");
    // Half 2: the future-dated claim was recorded at 500 so its effective time is 500, which
    // loses to a claim observed at 600. Unclamped (10_000) it would win.
    const early = claim({ _id: "x", _creationTime: 500, observedAt: 10_000 });
    const later = claim({ _id: "y", _creationTime: 900, observedAt: 600 });
    expect(resolveField([early, later], sources)!.winner._id).toBe("y");
  });

  test("the verdict does not depend on when it is computed", () => {
    // No clock input exists; same claims, same winner, however many times it runs.
    const input = [claim({ _id: "x", _creationTime: 500, observedAt: 10_000 }), claim({ _id: "y", _creationTime: 900, observedAt: 600 })];
    expect(resolveField(input, sources)!.winner._id).toBe(resolveField(input, sources)!.winner._id);
  });

  test("a missing observedAt sorts oldest, never newest", () => {
    const missing = claim({ _id: "a", observedAt: undefined as unknown as number });
    const dated = claim({ _id: "z", observedAt: 1 });
    expect(resolveField([missing, dated], sources)!.winner._id).toBe("z");
  });

  test("returns null for an empty claim list", () => {
    expect(resolveField([], sources)).toBeNull();
  });

  test("does not mutate its input", () => {
    const input = [claim({ _id: "b" }), claim({ _id: "a" })];
    resolveField(input, sources);
    expect(input.map((c) => c._id)).toEqual(["b", "a"]);
  });
});
