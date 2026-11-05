import { expect, test } from "vitest";
import { parseCsv } from "./csv";

test("parses headers and rows, tolerating CRLF, a BOM and a trailing newline", () => {
  const out = parseCsv("﻿Name,Email\r\nJane,jane@acme.com\r\nBob,bob@acme.com\r\n");
  expect(out.headers).toEqual(["Name", "Email"]);
  expect(out.rows).toEqual([["Jane", "jane@acme.com"], ["Bob", "bob@acme.com"]]);
});

test("handles quoted fields with commas, escaped quotes and embedded newlines", () => {
  const out = parseCsv('Name,Note\n"Doe, Jane","said ""hi""\nthen left"\n');
  expect(out.rows).toEqual([["Doe, Jane", 'said "hi"\nthen left']]);
});

test("skips blank lines and trims headers", () => {
  const out = parseCsv(" A , B \n\n1,2\n\n");
  expect(out.headers).toEqual(["A", "B"]);
  expect(out.rows).toEqual([["1", "2"]]);
});

test("an empty or whitespace-only file is a named error, not an empty result", () => {
  expect(() => parseCsv("")).toThrow("empty_file");
  expect(() => parseCsv("﻿ \n\n")).toThrow("empty_file");
});

test("duplicate header names are a named error listing the culprit", () => {
  expect(() => parseCsv("Email,Name,Email\na,b,c")).toThrow("duplicate_headers: Email");
});

test("a header-only file parses to zero rows", () => {
  expect(parseCsv("A,B\n")).toEqual({ headers: ["A", "B"], rows: [] });
});

test("an unterminated quote is a named error rather than silently swallowing the rest of the file", () => {
  expect(() => parseCsv('A,B\n"oops,2\n3,4\n')).toThrow("unterminated_quote");
});
