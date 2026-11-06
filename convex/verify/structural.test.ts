import { describe, expect, test } from "vitest";
import { DISPOSABLE_DOMAINS, ROLE_LOCAL_PARTS } from "./lists";
import { REASONS } from "./schema";
import { STRUCTURAL_RULES_REVISION, scanEmail, scanPhone, structuralLogic, verifyEmailStructure, verifyPhoneStructure, type Probe } from "./structural";

const email = (s: string) => verifyEmailStructure(s);
const phone = (s: string, region?: string) => verifyPhoneStructure(s, region);

describe("verifyEmailStructure", () => {
  test("a syntactically valid address passes", () => {
    for (const ok of ["bob.tables@acme.com", "Bob.Tables@Acme.COM", "a@b.co", "first+tag@sub.example.co.uk", "o'brien@acme.com", "x_y-z@my-corp.io", "  padded@acme.com  ", "a@xn--bcher-kva.example"]) {
      expect(email(ok), ok).toEqual({ kind: "email", outcome: "pass", reason: "ok" });
    }
  });

  test("a role address (info@, sales@) returns unknown, not pass, whatever its case or +tag", () => {
    for (const role of ["info@acme.com", "SALES@acme.com", "Support@acme.com", "info+campaign@acme.com", "no-reply@acme.com"]) {
      expect(email(role), role).toEqual({ kind: "email", outcome: "unknown", reason: "role" });
    }
    // a person whose name merely contains a role word is a person
    expect(email("info.smith@acme.com").outcome).toBe("pass");
  });

  test("a disposable-domain address fails, including a subdomain of a listed domain", () => {
    for (const bad of ["x@mailinator.com", "X@MAILINATOR.COM", "x@sub.mailinator.com", "x@a.b.yopmail.com", "info@mailinator.com"]) {
      expect(email(bad), bad).toEqual({ kind: "email", outcome: "fail", reason: "disposable" });
    }
    expect(email("x@notmailinator.com").outcome).toBe("pass");
    expect(email("x@mailinator.com.evil.example").outcome).toBe("pass"); // a suffix, not a prefix, is what lists
  });

  test("an address with no MX-capable shape (no dot in domain) fails", () => {
    expect(email("bob@localhost")).toEqual({ kind: "email", outcome: "fail", reason: "domain_shape" });
    for (const bad of ["bob@acme", "bob@acme.", "bob@.com", "bob@acme..com", "bob@-acme.com", "bob@acme-.com", "bob@acme.c", "bob@1.2.3.4", "bob@acme_x.com", "bob@ac me.com", "bob@"]) {
      expect(email(bad), bad).toMatchObject({ outcome: "fail", reason: "domain_shape" });
    }
  });

  test("malformed local parts and structure fail as syntax", () => {
    for (const bad of ["plainaddress", "@acme.com", ".bob@acme.com", "bob.@acme.com", "bo..b@acme.com", "bob@@acme.com", "a@b@acme.com", "bob smith@acme.com", '"bob"@acme.com', "bob(x)@acme.com", "bob\t@acme.com", "bob\u0000@acme.com"]) {
      expect(email(bad), bad).toMatchObject({ outcome: "fail", reason: "syntax" });
    }
  });

  test("empty, whitespace and non-string input is unknown and never throws", () => {
    expect(email("")).toEqual({ kind: "email", outcome: "unknown", reason: "empty" });
    expect(email("  \t\n ")).toEqual({ kind: "email", outcome: "unknown", reason: "empty" });
    for (const weird of [null, undefined, 42, {}, [], true] as unknown as string[]) expect(() => email(weird)).not.toThrow();
    expect(email(null as unknown as string)).toEqual({ kind: "email", outcome: "unknown", reason: "not_text" });
  });

  test("length limits: 64 local, 63 label, 253 domain, 254 total", () => {
    expect(email(`${"a".repeat(64)}@acme.com`).outcome).toBe("pass");
    expect(email(`${"a".repeat(65)}@acme.com`)).toMatchObject({ outcome: "fail", reason: "syntax" });
    expect(email(`a@${"b".repeat(63)}.com`).outcome).toBe("pass");
    expect(email(`a@${"b".repeat(64)}.com`)).toMatchObject({ outcome: "fail", reason: "domain_shape" });
    expect(email(`a@${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.${"e".repeat(60)}.${"f".repeat(10)}.com`)).toMatchObject({ outcome: "fail" }); // >253
    expect(email(`${"a".repeat(300)}@acme.com`)).toEqual({ kind: "email", outcome: "fail", reason: "too_long" });
  });

  test("a non-ASCII address that is otherwise well-formed is unknown, not a failure", () => {
    expect(email("jörg@acme.com")).toEqual({ kind: "email", outcome: "unknown", reason: "non_ascii" });
    expect(email("bob@bücher.de")).toEqual({ kind: "email", outcome: "unknown", reason: "non_ascii" });
    expect(email("jörg@@acme.com").outcome).toBe("fail"); // but a real defect still fails
  });

  test("every reason it can return is one the schema declares", () => {
    const seen = new Set<string>();
    for (const s of ["", "a@b.co", "info@acme.com", "x@mailinator.com", "bob@acme", "plain", "ö@acme.com", "a".repeat(300), null as unknown as string]) seen.add(email(s).reason);
    for (const r of seen) expect(REASONS as readonly string[]).toContain(r);
  });
});

describe("verifyPhoneStructure", () => {
  test("an empty or whitespace phone returns unknown, never throws", () => {
    expect(phone("")).toEqual({ kind: "phone", outcome: "unknown", reason: "empty" });
    expect(phone("  \n\t ")).toEqual({ kind: "phone", outcome: "unknown", reason: "empty" });
    for (const weird of [null, undefined, 5551234567, {}] as unknown as string[]) expect(() => phone(weird)).not.toThrow();
    expect(phone(undefined as unknown as string).outcome).toBe("unknown");
  });

  test("international and national numbers pass on shape", () => {
    for (const ok of ["+1 555 010 4242", "+44 20 7946 0958", "+1 (555) 010-4242", "+49.30.1234567", "555 010 4242", "(555) 010-4242", "555-0104", "+1 555 010 4242 x123", "555 010 4242 ext. 22", "555 010 4242 EXT 5", "555 010 4242 x: 9"]) {
      expect(phone(ok), ok).toEqual({ kind: "phone", outcome: "pass", reason: "ok" });
    }
  });

  test("malformed numbers fail", () => {
    for (const bad of ["abc", "555-CALL-NOW", "++1 555 010 4242", "1+555 010 4242", "555 010 4242 x", "555 010 4242 x1234567", "555 010 4242 x1 2", "555 010 4242 ex", "555 010 4242 ext", "555 010 4242 extx5", "555 010 4242 ext-5", "()", "+0 555 010 4242"]) {
      expect(phone(bad), bad).toMatchObject({ outcome: "fail" });
    }
    expect(phone("12345")).toMatchObject({ outcome: "fail", reason: "bad_length" });
    expect(phone("+1 555")).toMatchObject({ outcome: "fail", reason: "bad_length" });
    expect(phone("1".repeat(16))).toMatchObject({ outcome: "fail", reason: "bad_length" });
    expect(phone("1".repeat(41))).toEqual({ kind: "phone", outcome: "fail", reason: "too_long" });
  });

  test("a North American region demands 10 digits (11 with a leading 1); other regions are not judged beyond a shape", () => {
    expect(phone("555 010 4242", "US").outcome).toBe("pass");
    expect(phone("1 555 010 4242", "ca").outcome).toBe("pass");
    expect(phone("2 555 010 4242", "US")).toMatchObject({ outcome: "fail", reason: "bad_length" });
    expect(phone("555 0104", "US")).toMatchObject({ outcome: "fail", reason: "bad_length" });
    expect(phone("555 0104", "GB").outcome).toBe("pass");
    expect(phone("555 0104", "not a region").outcome).toBe("pass");
  });
});

/*
 * LINEARITY, PINNED BEHAVIOURALLY. The ledger records that a length cap can hide a quadratic scanner from a test that
 * only feeds capped input, and that a wall-clock budget is flaky and hides slow-but-passing code. So the scanners are
 * fed UNCAPPED input far past any cap, and the pin is the number of characters they READ (a `Probe`): a scanner
 * that reads each character at most once cannot be quadratic, whatever the machine. The adversarial shapes are the
 * ones that make a backtracking regex or a rescanning loop blow up: repeated near-matches that fail at the very end.
 */
describe("the scanners are linear: each character is read at most once, on input far past every cap", () => {
  const N = 200_000;
  const emailShapes: Record<string, string> = {
    "dot-separated local part, then no @": "a.".repeat(N),
    "@ after @ after @": "a@".repeat(N),
    "a long label of hyphens": `a@${"-".repeat(N)}`,
    "a long label that ends in a hyphen": `a@${"a".repeat(N)}-.com`,
    "a domain of many one-letter labels": `a@${"a.".repeat(N)}`,
    "a domain of many labels ending in a bad character": `a@${"a.".repeat(N)}_`,
    "many plus signs in the local part": `${"+".repeat(N)}@acme.com`,
    "an all-digit last label": `a@b.${"1".repeat(N)}`,
    "only dots": ".".repeat(N),
    "non-ASCII throughout": `${"ö".repeat(N)}@${"ö.".repeat(N)}com`,
    "well-formed but enormous": `${"a".repeat(60)}@${("b".repeat(60) + ".").repeat(N / 60)}com`,
  };
  // scanPhone has no early exit on length (the public verifier caps the text first), so it really walks all of these.
  const P = 20_000;
  const phoneShapes: Record<string, string> = {
    "separators only": " -.()".repeat(P),
    "digits then a bad character": `${"1".repeat(P)}z`,
    "plus signs": "+".repeat(P),
    "repeated extensions": "1x".repeat(P),
    "an extension that never ends": `1x${"1".repeat(P)}`,
    "parentheses around nothing": "()".repeat(P),
    "separators then digits": `${" ".repeat(P)}${"1".repeat(P)}`,
  };

  const steps = (scan: (s: string, p?: Probe) => unknown, input: string) => {
    const probe: Probe = { steps: 0 };
    scan(input, probe);
    return probe.steps;
  };

  test.each(Object.entries(emailShapes))("scanEmail reads each character at most once: %s", (_name, input) => {
    expect(input.length).toBeGreaterThan(1000);
    expect(steps(scanEmail, input)).toBeLessThanOrEqual(input.length);
  });

  test.each(Object.entries(phoneShapes))("scanPhone reads each character at most once: %s", (_name, input) => {
    expect(input.length).toBeGreaterThan(1000);
    expect(steps(scanPhone, input)).toBeLessThanOrEqual(input.length);
  });

  test.each(Object.entries(emailShapes))("the same shapes cut to the longest input the public verifier accepts (254), where no early exit hides the work: %s", (_name, input) => {
    // A scanner that bails out at a length limit does little work on a huge input whatever its complexity; at 254
    // characters the limit has not fired, so a rescan shows up as steps well above the length.
    const cut = input.slice(0, 254);
    expect(steps(scanEmail, cut)).toBeLessThanOrEqual(cut.length);
    // and past the limit the scanner stops within a small constant of it: it does not read the rest.
    expect(steps(scanEmail, input)).toBeLessThanOrEqual(400);
  });

  test("doubling the input at most doubles the work (the scanner's cost is proportional, not just under a ceiling)", () => {
    for (const make of [(n: number) => `a@${"a.".repeat(n)}com`, (n: number) => "a.".repeat(n), (n: number) => `${"1".repeat(n)}z`]) {
      const small = steps(scanEmail, make(50_000));
      const large = steps(scanEmail, make(100_000));
      expect(large).toBeLessThanOrEqual(small * 2 + 4);
    }
  });

  test("the pin is load-bearing: a scanner that rescans the input fails it", () => {
    // A mutant with the classic defect: for every dot, look back over everything before it.
    const rescanning = (s: string, probe?: Probe) => {
      for (let i = 0; i < s.length; i++) {
        if (probe) probe.steps++;
        if (s[i] === ".") for (let j = 0; j < i; j++) if (probe) probe.steps++;
      }
    };
    const input = "a.".repeat(5_000);
    expect(steps(rescanning, input)).toBeGreaterThan(input.length * 10);
  });

  test("the public verifiers return promptly and correctly on the same input (a wrong answer or a hang both fail)", () => {
    for (const input of Object.values(emailShapes)) expect(["pass", "fail", "unknown"]).toContain(email(input).outcome);
    for (const input of Object.values(phoneShapes)) expect(["pass", "fail", "unknown"]).toContain(phone(input).outcome);
    expect(email(`a@${"a.".repeat(N)}`)).toEqual({ kind: "email", outcome: "fail", reason: "too_long" });
    expect(email(`${"a.".repeat(30)}b@acme.com`).outcome).toBe("pass"); // under the cap, same adversarial shape: right answer
    expect(email(`${"a.".repeat(30)}@acme.com`)).toMatchObject({ outcome: "fail", reason: "syntax" });
  });

  test("structural.ts uses no regular expression at all", async () => {
    const files = import.meta.glob("./structural.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    const src = Object.values(files)[0]!.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toMatch(/\bnew RegExp\b|\.match\(|\.matchAll\(|\.replace\(|\.test\(|\.split\(|\.search\(/);
    // a regex LITERAL: a slash opening after `(`, `=`, `,`, `:` or `return` and closing before flags
    expect(src).not.toMatch(/[(=,:]\s*\/(?![/*])[^/\n]+\/[gimsuy]*\s*[.),;]/);
  });
});

describe("structuralLogic: the lists are logic, so they fingerprint", () => {
  const base = { revision: STRUCTURAL_RULES_REVISION, disposable: DISPOSABLE_DOMAINS, roles: ROLE_LOCAL_PARTS };

  test("it is deterministic, order-independent and stable", () => {
    expect(structuralLogic(base)).toEqual(structuralLogic(base));
    expect(structuralLogic({ ...base, disposable: [...DISPOSABLE_DOMAINS].reverse(), roles: [...ROLE_LOCAL_PARTS].reverse() })).toEqual(structuralLogic(base));
    expect(structuralLogic().hash).toBe(structuralLogic(base).hash);
    expect(Number.isInteger(structuralLogic().short)).toBe(true);
    expect(structuralLogic().short).toBeGreaterThanOrEqual(0);
    expect(structuralLogic().short).toBeLessThan(2 ** 32);
  });

  test.each([
    ["a domain added to the disposable list", { ...base, disposable: [...DISPOSABLE_DOMAINS, "new-throwaway.example"] }],
    ["a domain removed from the disposable list", { ...base, disposable: DISPOSABLE_DOMAINS.slice(1) }],
    ["a domain swapped for another of the same length", { ...base, disposable: [...DISPOSABLE_DOMAINS.slice(1), "x".repeat(DISPOSABLE_DOMAINS[0]!.length)] }],
    ["a role added", { ...base, roles: [...ROLE_LOCAL_PARTS, "newrole"] }],
    ["a role removed", { ...base, roles: ROLE_LOCAL_PARTS.slice(1) }],
    ["a domain moved into the role list", { ...base, disposable: DISPOSABLE_DOMAINS.slice(1), roles: [...ROLE_LOCAL_PARTS, DISPOSABLE_DOMAINS[0]!] }],
    ["the code's revision bumped", { ...base, revision: STRUCTURAL_RULES_REVISION + 1 }],
    ["entries merged across the delimiter", { ...base, disposable: ["a.com|3=b.c", ...DISPOSABLE_DOMAINS.slice(2)] }],
  ])("%s changes the fingerprint", (_name, lists) => {
    expect(structuralLogic(lists).hash).not.toBe(structuralLogic(base).hash);
  });

  test("it reads the lists' CURRENT contents, not a value cached at load", () => {
    const before = structuralLogic().hash;
    (DISPOSABLE_DOMAINS as string[]).push("added-at-runtime.example");
    try {
      expect(structuralLogic().hash).not.toBe(before);
      expect(email("x@added-at-runtime.example")).toMatchObject({ outcome: "fail", reason: "disposable" });
    } finally {
      (DISPOSABLE_DOMAINS as string[]).pop();
    }
    expect(structuralLogic().hash).toBe(before);
  });
});
