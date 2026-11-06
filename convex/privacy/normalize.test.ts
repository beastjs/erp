import { expect, test } from "vitest";
import { normalizeIdentifier } from "./normalize";

test("' Bob@ACME.com ' and 'bob@acme.com' normalize identically", () => {
  expect(normalizeIdentifier(" Bob@ACME.com ")).toBe("bob@acme.com");
  expect(normalizeIdentifier(" Bob@ACME.com ")).toBe(normalizeIdentifier("bob@acme.com"));
});

test("unicode-homoglyph and full-width variants normalize identically", () => {
  // NFKC folds compatibility forms: full-width Latin, the ligature sign, the Kelvin sign.
  expect(normalizeIdentifier("ｂｏｂ@ａｃｍｅ.ｃｏｍ")).toBe("bob@acme.com");
  expect(normalizeIdentifier("bob@acme.com")).toBe(normalizeIdentifier("ｂｏｂ＠ａｃｍｅ．ｃｏｍ"));
  expect(normalizeIdentifier("Kate@acme.com")).toBe("kate@acme.com");
});

test("tagged-address suffixes are stripped, so a +tag cannot dodge the list", () => {
  expect(normalizeIdentifier("bob+newsletter@acme.com")).toBe("bob@acme.com");
  expect(normalizeIdentifier("BOB+a+b@Acme.com")).toBe("bob@acme.com");
});

test("a domain is reduced to its registrable host", () => {
  expect(normalizeIdentifier("https://www.Acme.com/pricing?x=1", "domain")).toBe("acme.com");
  expect(normalizeIdentifier("WWW.ACME.COM", "domain")).toBe("acme.com");
  expect(normalizeIdentifier("acme.com")).toBe("acme.com");
});

test("phones and profile URLs normalize through the same shared module as ingest", () => {
  expect(normalizeIdentifier("+1 (555) 010-1234")).toBe("15550101234");
  expect(normalizeIdentifier("https://www.LinkedIn.com/in/Jane/?x=1")).toBe("linkedin.com/in/jane");
});

test("an unusable identifier is refused, never hashed as an empty string", () => {
  for (const bad of ["", "   ", "@", "not an identifier", "a@", "@b.com"]) {
    expect(() => normalizeIdentifier(bad), JSON.stringify(bad)).toThrow(/not a usable/);
  }
  expect(() => normalizeIdentifier("bob", "email")).toThrow(/not a usable/);
});
