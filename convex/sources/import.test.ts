/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { beforeEach, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { CANDIDATE_CONTRACT_VERSION, checkContractVersion } from "./contract";
import { insertCandidate } from "./mutations";

const modules = import.meta.glob("/convex/**/*.ts");

let raw: ReturnType<typeof convexTest>;
let t: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>;
let orgId: Id<"orgs">;
let sourceId: Id<"sources">;
let runId: Id<"discoveryRuns">;
let mappingId: Id<"columnMappings">;

const COLUMNS = {
  "Company Site": "company.domain",
  Company: "company.name",
  Email: "person.email",
  Name: "person.fullName",
  Title: "person.jobTitle",
};

beforeEach(async () => {
  raw = convexTest(schema, modules);
  const seeded = await raw.run(async (ctx) => {
    const orgId = await ctx.db.insert("orgs", { name: "Org 1", createdAt: 0 });
    const sourceId = await ctx.db.insert("sources", { orgId, key: "csv", kind: "csv", trustWeight: 0.8, lawfulBasis: "consent" });
    return { orgId, sourceId };
  });
  orgId = seeded.orgId;
  sourceId = seeded.sourceId;
  t = raw.withIdentity({ subject: "u1", orgId });
  runId = await t.mutation(api.runs.mutations.startRun, { sourceId, creditBudget: 100 });
  mappingId = await t.mutation(api.sources.import.saveMapping, { name: "crm", columns: COLUMNS });
});

const jane = () => ({
  "Company Site": "https://www.Acme.com/",
  Company: "Acme Inc",
  Email: "Jane+news@Acme.com",
  Name: "Jane Doe",
  Title: "CTO",
});

const all = <T extends "claims" | "accounts" | "contacts" | "candidates">(table: T) =>
  raw.run((ctx) => ctx.db.query(table).collect());
const getRun = () => t.query(api.runs.queries.getRun, { runId });

// ---------------------------------------------------------------- importRows

test("importRows maps columns and inserts candidates", async () => {
  const out = await t.mutation(api.sources.import.importRows, { runId, mappingId, rows: [jane()] });
  expect(out.inserted).toBe(1);
  expect(out.rejected).toEqual([]);
  const [c] = await all("candidates");
  expect(c.status).toBe("pending");
  expect(c.runId).toBe(runId);
  expect(c.sourceId).toBe(sourceId);
  // Stored raw: normalization happens at consumption, not at the mapping.
  expect(c.candidate.company.domain).toBe("https://www.Acme.com/");
  expect(c.candidate.person).toMatchObject({ email: "Jane+news@Acme.com", fullName: "Jane Doe", jobTitle: "CTO" });
  expect(out.candidateIds).toEqual([c._id]);
  expect(await getRun()).toMatchObject({ rowsProcessed: 1, candidatesInserted: 1, duplicates: 0, rowsRejected: 0 });
});

test("importRows reports per-row errors without aborting the batch", async () => {
  const out = await t.mutation(api.sources.import.importRows, {
    runId,
    mappingId,
    rows: [jane(), { ...jane(), Email: "not-an-email" }, { Title: "CEO" }, { ...jane(), Email: "bob@globex.com", "Company Site": "globex.com" }],
  });
  expect(out.inserted).toBe(2);
  expect(out.rejected.map((r) => r.row)).toEqual([1, 2]);
  expect(out.rejected[0]!.errors.join(" ")).toContain("email");
  expect(out.rejected[1]!.errors.length).toBeGreaterThan(0);
  expect(await all("candidates")).toHaveLength(2);
  expect(await getRun()).toMatchObject({ rowsProcessed: 4, candidatesInserted: 2, rowsRejected: 2 });
});

test("rejected row numbers continue from rowOffset so they point at the source file", async () => {
  const out = await t.mutation(api.sources.import.importRows, { runId, mappingId, rowOffset: 500, rows: [jane(), { Title: "x" }] });
  expect(out.rejected.map((r) => r.row)).toEqual([501]);
});

test("a date in the acquiredAt column is parsed; a bad one is a row error", async () => {
  const id = await t.mutation(api.sources.import.saveMapping, {
    name: "dated",
    columns: { ...COLUMNS, Seen: "acquisition.acquiredAt" },
  });
  const out = await t.mutation(api.sources.import.importRows, {
    runId,
    mappingId: id,
    rows: [{ ...jane(), Seen: "2025-03-01T00:00:00Z" }, { ...jane(), Email: "b@acme.com", Seen: "yesterday-ish" }],
  });
  expect(out.inserted).toBe(1);
  expect(out.rejected).toHaveLength(1);
  expect(out.rejected[0]!.errors.join(" ")).toContain("acquiredAt");
  expect((await all("candidates"))[0]!.candidate.acquisition.acquiredAt).toBe(Date.parse("2025-03-01T00:00:00Z"));
});

test("importRows on an empty row set returns inserted 0 and no error", async () => {
  const out = await t.mutation(api.sources.import.importRows, { runId, mappingId, rows: [] });
  expect(out).toMatchObject({ inserted: 0, rejected: [] });
  expect(await getRun()).toMatchObject({ rowsProcessed: 0 });
});

test("importRows rejects a mapping with duplicate target fields", async () => {
  await expect(
    t.mutation(api.sources.import.saveMapping, { name: "dup", columns: { Email: "person.email", "Work Email": "person.email" } }),
  ).rejects.toThrow("duplicate target");
  // saveMapping is not the only way a row can get into the table, so the importer re-checks.
  const sneaky = await raw.run((ctx) =>
    ctx.db.insert("columnMappings", {
      orgId,
      name: "sneaky",
      columns: [
        { column: "A", target: "person.email" },
        { column: "B", target: "person.email" },
      ],
    }),
  );
  await expect(t.mutation(api.sources.import.importRows, { runId, mappingId: sneaky, rows: [{ A: "a@b.com", B: "c@d.com" }] })).rejects.toThrow(
    "duplicate target",
  );
  expect(await all("candidates")).toHaveLength(0);
});

test("saveMapping rejects unknown targets, an empty mapping and a reused name", async () => {
  await expect(t.mutation(api.sources.import.saveMapping, { name: "bad", columns: { A: "person.shoeSize" } })).rejects.toThrow("unknown target");
  await expect(t.mutation(api.sources.import.saveMapping, { name: "empty", columns: {} })).rejects.toThrow("at least one column");
  await expect(t.mutation(api.sources.import.saveMapping, { name: "crm", columns: { A: "person.email" } })).rejects.toThrow("already exists");
});

test("importRows names a mapped column that is absent from every row", async () => {
  await expect(
    t.mutation(api.sources.import.importRows, { runId, mappingId, rows: [{ Company: "Acme", "Company Site": "acme.com" }] }),
  ).rejects.toThrow("missing_columns: Email, Name, Title");
  expect(await all("candidates")).toHaveLength(0);
});

test("importRows refuses more rows than one mutation may safely process", async () => {
  const rows = Array.from({ length: 501 }, (_, i) => ({ ...jane(), Email: `p${i}@acme.com` }));
  await expect(t.mutation(api.sources.import.importRows, { runId, mappingId, rows })).rejects.toThrow("chunk_too_large");
  expect(await all("candidates")).toHaveLength(0);
});

test("importRows refuses a mapping or run from another org, and a finished run", async () => {
  const otherOrg = await raw.run((ctx) => ctx.db.insert("orgs", { name: "Org 2", createdAt: 0 }));
  const other = raw.withIdentity({ subject: "u2", orgId: otherOrg });
  await expect(other.mutation(api.sources.import.importRows, { runId, mappingId, rows: [jane()] })).rejects.toThrow("run not found");
  const otherRun = await raw.run(async (ctx) => {
    const src = await ctx.db.insert("sources", { orgId: otherOrg, key: "x", kind: "csv", trustWeight: 1, lawfulBasis: "consent" });
    return ctx.db.insert("discoveryRuns", {
      orgId: otherOrg, sourceId: src, status: "running", creditBudget: 1, creditsUsed: 0, startedAt: 1, rowsProcessed: 0,
      candidatesInserted: 0, duplicates: 0, rowsRejected: 0, candidatesConsumed: 0, candidatesRejected: 0,
    });
  });
  await expect(other.mutation(api.sources.import.importRows, { runId: otherRun, mappingId, rows: [jane()] })).rejects.toThrow("mapping not found");
  await t.mutation(api.runs.mutations.finishRun, { runId });
  await expect(t.mutation(api.sources.import.importRows, { runId, mappingId, rows: [jane()] })).rejects.toThrow("run_not_active");
});

test("a repeated import of the same file inserts nothing the second time", async () => {
  const rows = [jane(), { ...jane(), Email: "bob@globex.com", "Company Site": "globex.com" }];
  expect((await t.mutation(api.sources.import.importRows, { runId, mappingId, rows })).inserted).toBe(2);
  const again = await t.mutation(api.sources.import.importRows, { runId, mappingId, rows });
  expect(again.inserted).toBe(0);
  expect(again.rejected).toEqual([]);
  expect(await all("candidates")).toHaveLength(2);
  expect(await getRun()).toMatchObject({ rowsProcessed: 4, candidatesInserted: 2, duplicates: 2 });
});

// -------------------------------------------------------------------- ingest

const importAndIngest = async (rows: Array<Record<string, string>>) => {
  const imported = await t.mutation(api.sources.import.importRows, { runId, mappingId, rows });
  const ingested = await t.mutation(api.sources.ingest.ingestCandidates, { candidateIds: imported.candidateIds });
  return { imported, ingested };
};

test("ingest re-normalizes the raw candidate, creates subjects, writes claims and marks it consumed", async () => {
  const { ingested } = await importAndIngest([jane()]);
  expect(ingested).toEqual({ consumed: 1, rejected: 0 });

  const [candidate] = await all("candidates");
  expect(candidate.status).toBe("consumed");
  expect(candidate.candidate.company.domain).toBe("https://www.Acme.com/"); // the stored input is untouched

  const [account] = await all("accounts");
  const [contact] = await all("contacts");
  expect(account.display).toEqual({ name: "Acme Inc", domain: "acme.com" });
  expect(contact.display).toMatchObject({ name: "Jane Doe", email: "jane@acme.com", title: "CTO" });
  expect(contact.fields.find((f: { field: string }) => f.field === "accountId")?.value).toBe(account._id);

  const claims = await all("claims");
  expect(claims.length).toBeGreaterThan(0);
  for (const c of claims) {
    expect(c.method).toBe("observed");
    expect(c.sourceId).toBe(sourceId);
    expect(c.runId).toBe(runId);
    expect(c.orgId).toBe(orgId);
  }
  expect(await getRun()).toMatchObject({ candidatesConsumed: 1, candidatesRejected: 0 });
});

test("ingest dates every claim with the acquisition time the candidate carries", async () => {
  await importAndIngest([jane()]);
  const run = await getRun();
  for (const c of await all("claims")) expect(c.observedAt).toBe(run.startedAt);
});

test("two spellings of one company converge on one account; one contact per normalized email", async () => {
  await importAndIngest([
    jane(),
    { ...jane(), "Company Site": "ACME.com", Email: "bob@acme.com", Name: "Bob" },
    { ...jane(), "Company Site": "http://acme.com/about", Email: "JANE@ACME.COM", Name: "Jane D." },
  ]);
  expect(await all("accounts")).toHaveLength(1);
  expect(await all("contacts")).toHaveLength(2);
});

test("a re-observation after consumption inserts a fresh candidate and reuses the existing subjects", async () => {
  await importAndIngest([jane()]);
  const claimsBefore = (await all("claims")).length;

  const second = await importAndIngest([jane()]);
  // Dedupe is scoped to pending rows, so a consumed lead is a fresh observation, not a duplicate...
  expect(second.imported.inserted).toBe(1);
  expect(second.ingested).toEqual({ consumed: 1, rejected: 0 });
  // ...but it must not mint a second account or contact for the same entity.
  expect(await all("accounts")).toHaveLength(1);
  expect(await all("contacts")).toHaveLength(1);
  expect((await all("claims")).length).toBe(claimsBefore * 2);
  expect((await all("candidates")).map((c) => c.status)).toEqual(["consumed", "consumed"]);
});

test("a company-only candidate creates an account and no contact", async () => {
  await importAndIngest([{ "Company Site": "globex.com", Company: "Globex", Email: "", Name: "", Title: "" }]);
  expect(await all("accounts")).toHaveLength(1);
  expect(await all("contacts")).toHaveLength(0);
});

test("ingest only touches pending candidates: a second pass writes nothing", async () => {
  const { imported } = await importAndIngest([jane()]);
  const claims = (await all("claims")).length;
  const again = await t.mutation(api.sources.ingest.ingestCandidates, { candidateIds: imported.candidateIds });
  expect(again).toEqual({ consumed: 0, rejected: 0 });
  expect((await all("claims")).length).toBe(claims);
});

test("ingest rejects a stored candidate that no longer validates, and a rejection does not block a re-crawl", async () => {
  const bad = await raw.run((ctx) =>
    ctx.db.insert("candidates", {
      orgId, sourceId, dedupeHash: "domain:acme.com|", status: "pending", contractVersion: CANDIDATE_CONTRACT_VERSION,
      candidate: { company: { domain: "acme.com" }, acquisition: { acquiredAt: 1 }, surprise: true },
    }),
  );
  expect(await t.mutation(api.sources.ingest.ingestCandidates, { candidateIds: [bad] })).toEqual({ consumed: 0, rejected: 1 });
  const row = (await all("candidates"))[0]!;
  expect(row.status).toBe("rejected");
  expect(row.rejectionReason).toContain("surprise");
  expect(await all("accounts")).toHaveLength(0);
  // A rejection judges one observation, not the lead forever.
  const fresh = await t.run((ctx) =>
    insertCandidate(ctx, { candidate: { company: { domain: "acme.com" }, acquisition: { acquiredAt: 2 } }, sourceId }),
  );
  expect(fresh).not.toBeNull();
});

test("ingest refuses a stored candidate whose contract version is incompatible", async () => {
  const old = await raw.run((ctx) =>
    ctx.db.insert("candidates", {
      orgId, sourceId, dedupeHash: "domain:acme.com|", status: "pending", contractVersion: "9.0.0",
      candidate: { company: { domain: "acme.com" }, acquisition: { acquiredAt: 1 } },
    }),
  );
  expect(await t.mutation(api.sources.ingest.ingestCandidates, { candidateIds: [old] })).toEqual({ consumed: 0, rejected: 1 });
  expect((await all("candidates"))[0]!.rejectionReason).toContain("contract");
});

test("one candidate that cannot be processed is rejected without aborting the rest of the batch", async () => {
  const goodIds = (await t.mutation(api.sources.import.importRows, { runId, mappingId, rows: [jane()] })).candidateIds;
  const orphan = await raw.run(async (ctx) => {
    const gone = await ctx.db.insert("sources", { orgId, key: "gone", kind: "csv", trustWeight: 1, lawfulBasis: "consent" });
    const id = await ctx.db.insert("candidates", {
      orgId, sourceId: gone, dedupeHash: "domain:globex.com|", status: "pending", contractVersion: CANDIDATE_CONTRACT_VERSION,
      candidate: { company: { domain: "globex.com" }, acquisition: { acquiredAt: 1 } },
    });
    await ctx.db.delete(gone);
    return id;
  });
  const out = await t.mutation(api.sources.ingest.ingestCandidates, { candidateIds: [orphan, ...goodIds] });
  expect(out).toEqual({ consumed: 1, rejected: 1 });
  const rows = await all("candidates");
  expect(rows.find((r) => r._id === orphan)!.status).toBe("rejected");
  expect(rows.find((r) => r._id === orphan)!.rejectionReason).toContain("source not found");
  expect(rows.find((r) => r._id === goodIds[0])!.status).toBe("consumed");
  // The good candidate's subjects exist; the orphan created none.
  expect((await all("accounts")).map((a) => a.display.domain)).toEqual(["acme.com"]);
});

test("ingestCandidates refuses another org's candidate and an oversized batch", async () => {
  const id = (await t.mutation(api.sources.import.importRows, { runId, mappingId, rows: [jane()] })).candidateIds[0]!;
  const otherOrg = await raw.run((ctx) => ctx.db.insert("orgs", { name: "Org 2", createdAt: 0 }));
  const other = raw.withIdentity({ subject: "u2", orgId: otherOrg });
  await expect(other.mutation(api.sources.ingest.ingestCandidates, { candidateIds: [id] })).rejects.toThrow("candidate not found");
  const ids = Array.from({ length: 51 }, () => id);
  await expect(t.mutation(api.sources.ingest.ingestCandidates, { candidateIds: ids })).rejects.toThrow("batch_too_large");
});

// ----------------------------------------------------------------- importCsv

const store = (text: string) => raw.run((ctx) => ctx.storage.store(new Blob([text])));
const csvOf = (n: number) =>
  ["Company Site,Company,Email,Name,Title", ...Array.from({ length: n }, (_, i) => `co${i}.com,Co ${i},p${i}@co${i}.com,Person ${i},Eng`)].join("\n");

test("importCsv is chunked: a large file reports progress per chunk", async () => {
  const out = await t.action(api.sources.import.importCsv, { runId, mappingId, storageId: await store(csvOf(1001)) });
  expect(out.chunks).toEqual([
    { offset: 0, processed: 500, inserted: 500 },
    { offset: 500, processed: 500, inserted: 500 },
    { offset: 1000, processed: 1, inserted: 1 },
  ]);
  expect(out).toMatchObject({ inserted: 1001, duplicates: 0, rejectedCount: 0, consumed: 1001 });
  expect(await getRun()).toMatchObject({ status: "completed", rowsProcessed: 1001, candidatesInserted: 1001, candidatesConsumed: 1001 });
  expect((await getRun()).finishedAt).toBeDefined();
}, 120_000);

test("importCsv collects rejected rows across chunks, numbered against the file", async () => {
  const lines = csvOf(3).split("\n");
  lines.splice(2, 0, ",,not-an-email,Bad,Eng"); // data row 1
  const out = await t.action(api.sources.import.importCsv, { runId, mappingId, storageId: await store(lines.join("\n")) });
  expect(out.inserted).toBe(3);
  expect(out.rejectedCount).toBe(1);
  expect(out.rejected.map((r) => r.row)).toEqual([1]);
});

test("importCsv fails with a named error before inserting anything", async () => {
  const cases: Array<[string, string]> = [
    ["", "empty_file"],
    ["Company Site,Email,Email\na.com,a@a.com,b@a.com", "duplicate_headers: Email"],
    ["Company Site,Company\na.com,A", "missing_columns: Email, Name, Title"],
  ];
  for (const [text, message] of cases) {
    await expect(t.action(api.sources.import.importCsv, { runId, mappingId, storageId: await store(text) })).rejects.toThrow(message);
  }
  expect(await all("candidates")).toHaveLength(0);
  expect((await getRun()).status).toBe("running");
});

test("importCsv on a header-only file completes the run with zero rows", async () => {
  const out = await t.action(api.sources.import.importCsv, { runId, mappingId, storageId: await store("Company Site,Company,Email,Name,Title\n") });
  expect(out).toMatchObject({ inserted: 0, chunks: [], consumed: 0 });
  expect((await getRun()).status).toBe("completed");
});

// ------------------------------------------------------------ addManualLead

test("addManualLead records claims with method observed, sourced to the operator", async () => {
  const id = await t.mutation(api.sources.import.addManualLead, {
    candidate: {
      person: { fullName: "Pat Lee", email: "Pat@Initech.com" },
      company: { name: "Initech", domain: "https://initech.com" },
      acquisition: { acquiredAt: 5000, channel: "referral" },
    },
  });
  const [cand] = await all("candidates");
  expect(cand._id).toBe(id);
  expect(cand.status).toBe("consumed");
  const sources = await raw.run((ctx) => ctx.db.query("sources").collect());
  const operator = sources.find((s) => s.kind === "manual")!;
  expect(operator.key).toMatch(/^manual:/);
  expect(cand.sourceId).toBe(operator._id);
  const claims = await all("claims");
  expect(claims.length).toBeGreaterThan(0);
  for (const c of claims) {
    expect(c.method).toBe("observed");
    expect(c.sourceId).toBe(operator._id);
    expect(c.observedAt).toBe(5000);
  }
  expect((await all("contacts"))[0]!.display.email).toBe("pat@initech.com");
  // A second entry by the same operator reuses their source rather than minting another.
  await t.mutation(api.sources.import.addManualLead, { candidate: { company: { domain: "globex.com" }, acquisition: { acquiredAt: 1 } } });
  expect((await raw.run((ctx) => ctx.db.query("sources").collect())).filter((s) => s.kind === "manual")).toHaveLength(1);
});

test("addManualLead rejects an invalid candidate and a pending duplicate with named errors", async () => {
  await expect(t.mutation(api.sources.import.addManualLead, { candidate: { acquisition: { acquiredAt: 1 } } })).rejects.toThrow("invalid candidate");
  await t.mutation(api.sources.import.importRows, { runId, mappingId, rows: [jane()] });
  await expect(
    t.mutation(api.sources.import.addManualLead, {
      candidate: { person: { email: "jane@acme.com" }, company: { domain: "acme.com" }, acquisition: { acquiredAt: 1 } },
    }),
  ).rejects.toThrow("duplicate_candidate");
});

// --------------------------------------------- producer-declared contract version

test("checkContractVersion: same MAJOR with equal or older MINOR is accepted; anything else is refused", () => {
  const [maj, min] = CANDIDATE_CONTRACT_VERSION.split(".").map(Number) as [number, number];
  expect(checkContractVersion(CANDIDATE_CONTRACT_VERSION)).toEqual({ ok: true });
  expect(checkContractVersion(`${maj}.${min}.7`)).toEqual({ ok: true }); // PATCH never matters
  if (min > 0) expect(checkContractVersion(`${maj}.${min - 1}.0`)).toEqual({ ok: true });
  expect(checkContractVersion(`${maj + 1}.0.0`)).toMatchObject({ ok: false });
  expect(checkContractVersion(`${maj}.${min + 1}.0`)).toMatchObject({ ok: false }); // producer ahead of Core
  if (maj > 0) expect(checkContractVersion(`${maj - 1}.0.0`)).toMatchObject({ ok: false });
  for (const junk of ["", "1", "1.0", "v1.0.0", "1.0.0-beta", "1.0.0.0", "a.b.c", "01.0.0", "1.-1.0", undefined, 1, null]) {
    expect(checkContractVersion(junk)).toMatchObject({ ok: false });
  }
});

const lead = (domain = "acme.com") => ({ company: { domain }, acquisition: { acquiredAt: 1 } });

test("submitCandidates stores the producer's declared version, not Core's", async () => {
  const out = await t.mutation(api.sources.import.submitCandidates, { sourceId, runId, contractVersion: `${CANDIDATE_CONTRACT_VERSION.split(".")[0]}.0.9`, candidates: [lead()] });
  expect(out).toMatchObject({ inserted: 1, duplicates: 0, rejected: [] });
  expect((await all("candidates"))[0]!.contractVersion).toBe(`${CANDIDATE_CONTRACT_VERSION.split(".")[0]}.0.9`);
  expect(out.candidateIds).toHaveLength(1);
  expect(await getRun()).toMatchObject({ rowsProcessed: 1, candidatesInserted: 1 });
});

test("submitCandidates refuses a MAJOR mismatch outright rather than guessing", async () => {
  await expect(
    t.mutation(api.sources.import.submitCandidates, { sourceId, contractVersion: "9.0.0", candidates: [lead()] }),
  ).rejects.toThrow("contract_version_unsupported");
  await expect(
    t.mutation(api.sources.import.submitCandidates, { sourceId, contractVersion: "not-a-version", candidates: [lead()] }),
  ).rejects.toThrow("contract_version_unsupported");
  expect(await all("candidates")).toHaveLength(0);
});

test("submitCandidates reports bad candidates and duplicates per item without aborting", async () => {
  const v = CANDIDATE_CONTRACT_VERSION;
  const out = await t.mutation(api.sources.import.submitCandidates, {
    sourceId, contractVersion: v, runId,
    candidates: [lead("acme.com"), { nope: 1 }, lead("acme.com"), lead("globex.com")],
  });
  expect(out.inserted).toBe(2);
  expect(out.duplicates).toBe(1);
  expect(out.rejected.map((r) => r.row)).toEqual([1]);
  expect(await getRun()).toMatchObject({ rowsProcessed: 4, candidatesInserted: 2, duplicates: 1, rowsRejected: 1 });
});

test("submitCandidates refuses an oversized batch and a source from another org", async () => {
  await expect(
    t.mutation(api.sources.import.submitCandidates, { sourceId, contractVersion: CANDIDATE_CONTRACT_VERSION, candidates: Array.from({ length: 501 }, () => lead()) }),
  ).rejects.toThrow("chunk_too_large");
  const otherOrg = await raw.run((ctx) => ctx.db.insert("orgs", { name: "Org 2", createdAt: 0 }));
  await expect(
    raw.withIdentity({ subject: "u2", orgId: otherOrg }).mutation(api.sources.import.submitCandidates, {
      sourceId, contractVersion: CANDIDATE_CONTRACT_VERSION, candidates: [lead()],
    }),
  ).rejects.toThrow("source not found");
});
