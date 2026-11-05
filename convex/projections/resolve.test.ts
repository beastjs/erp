import { describe, expect, test } from "vitest";
import type { Doc, Id } from "../_generated/dataModel";
import { resolveField } from "./resolve";

type Claim = Doc<"claims">;

const NOW = 1_000_000;
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
    _creationTime: 0,
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
    const r = resolveField([inferred, extracted, observed], sources, NOW)!;
    expect(r.winner.method).toBe("observed");
    expect(r.contenders.map((c) => c.method)).toEqual(["observed", "extracted", "inferred"]);
  });

  test("same method: higher source trust weight wins", () => {
    const low = claim({ sourceId: srcA, confidence: 1, observedAt: 9000 });
    const high = claim({ sourceId: srcB });
    expect(resolveField([low, high], sources, NOW)!.winner._id).toBe(high._id);
  });

  test("unknown source has zero trust", () => {
    const unknown = claim({ sourceId: "ghost" as Id<"sources"> });
    const known = claim({ sourceId: srcA, observedAt: 1 });
    expect(resolveField([unknown, known], sources, NOW)!.winner._id).toBe(known._id);
  });

  test("same method and trust: more recent observedAt wins", () => {
    const old = claim({ observedAt: 100, confidence: 1 });
    const recent = claim({ observedAt: 200 });
    expect(resolveField([old, recent], sources, NOW)!.winner._id).toBe(recent._id);
  });

  test("same method, trust and recency: higher confidence wins", () => {
    const lo = claim({ confidence: 0.2 });
    const hi = claim({ confidence: 0.8 });
    expect(resolveField([lo, hi], sources, NOW)!.winner._id).toBe(hi._id);
  });

  test("full tie resolves by claim id, deterministically", () => {
    const a = claim({ _id: "aaa" });
    const b = claim({ _id: "bbb" });
    const c = claim({ _id: "ccc" });
    const first = resolveField([a, b, c], sources, NOW)!.winner._id;
    const second = resolveField([c, a, b], sources, NOW)!.winner._id;
    const third = resolveField([b, c, a], sources, NOW)!.winner._id;
    expect(first).toBe("aaa");
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  test("a future observedAt does not win recency", () => {
    const legit = claim({ _id: "a", observedAt: NOW });
    const future = claim({ _id: "b", observedAt: NOW + 86_400_000 });
    // Clamped to NOW, so recency ties and the id decides, not the future date.
    expect(resolveField([future, legit], sources, NOW)!.winner._id).toBe("a");
    const futureLowId = claim({ _id: "0", observedAt: NOW + 86_400_000 });
    const past = claim({ _id: "z", observedAt: NOW - 1 });
    expect(resolveField([past, futureLowId], sources, NOW)!.winner._id).toBe("0");
  });

  test("a missing observedAt sorts oldest, never newest", () => {
    const missing = claim({ _id: "a", observedAt: undefined as unknown as number });
    const dated = claim({ _id: "z", observedAt: 1 });
    expect(resolveField([missing, dated], sources, NOW)!.winner._id).toBe("z");
  });

  test("returns null for an empty claim list", () => {
    expect(resolveField([], sources, NOW)).toBeNull();
  });

  test("does not mutate its input", () => {
    const input = [claim({ _id: "b" }), claim({ _id: "a" })];
    resolveField(input, sources, NOW);
    expect(input.map((c) => c._id)).toEqual(["b", "a"]);
  });
});
