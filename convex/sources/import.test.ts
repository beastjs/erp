/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { strToU8, zipSync } from "fflate";
import { beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { CANDIDATE_CONTRACT_VERSION, checkContractVersion } from "./contract";
import { MAX_IMPORT_BYTES, MAX_IMPORT_ROWS } from "./import";
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

const all = <T extends "claims" | "accounts" | "contacts" | "candidates" | "importChunks">(table: T) =>
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

// ---------------------------------------------- contact resolution within an account

const PEOPLE = { "Company Site": "company.domain", Name: "person.fullName", Profile: "person.profileUrl", Phone: "person.phone", Email: "person.email" };
const peopleRow = (o: Record<string, string>) => ({ "Company Site": "acme.com", Name: "", Profile: "", Phone: "", Email: "", ...o });
const ingestPeople = async (rows: Array<Record<string, string>>) => {
  const mid = await t.mutation(api.sources.import.saveMapping, { name: `people-${Math.random()}`, columns: PEOPLE });
  const imported = await t.mutation(api.sources.import.importRows, { runId, mappingId: mid, rows });
  await t.mutation(api.sources.ingest.ingestCandidates, { candidateIds: imported.candidateIds });
};

test("re-observing a contact known only by profileUrl reuses it (spelling variants included)", async () => {
  await ingestPeople([peopleRow({ Profile: "https://www.linkedin.com/in/jane-doe/" })]);
  await ingestPeople([peopleRow({ Profile: "http://LinkedIn.com/in/Jane-Doe?utm=x" })]);
  expect(await all("contacts")).toHaveLength(1);
});

test("re-observing a contact known only by phone reuses it", async () => {
  await ingestPeople([peopleRow({ Phone: "+1 (555) 010-2030" })]);
  await ingestPeople([peopleRow({ Phone: "1.555.010.2030" })]);
  expect(await all("contacts")).toHaveLength(1);
});

test("a contact known only by name is reused within the same account, but not across accounts", async () => {
  await ingestPeople([peopleRow({ Name: "Jane Doe" })]);
  await ingestPeople([peopleRow({ Name: "  JANE  doe " })]);
  expect(await all("contacts")).toHaveLength(1);
  await ingestPeople([peopleRow({ Name: "Jane Doe", "Company Site": "globex.com" })]);
  expect(await all("contacts")).toHaveLength(2);
});

test("the strongest key wins: a later sighting that adds an email attaches to the contact found by profile", async () => {
  await ingestPeople([peopleRow({ Profile: "linkedin.com/in/jane" })]);
  await ingestPeople([peopleRow({ Profile: "linkedin.com/in/jane", Email: "jane@acme.com" })]);
  expect(await all("contacts")).toHaveLength(1);
  // ...and now the email alone finds her, from anywhere.
  await ingestPeople([peopleRow({ Email: "JANE@acme.com", "Company Site": "other.com" })]);
  expect(await all("contacts")).toHaveLength(1);
});

test("a different person sharing a name is NOT merged into the first: strong identifiers that miss suppress the name key", async () => {
  await ingestPeople([peopleRow({ Name: "Jane Doe", Email: "jane.doe@acme.com" })]);
  await ingestPeople([peopleRow({ Name: "Jane Doe", Email: "jane.doe2@acme.com" })]);
  const contacts = await all("contacts");
  expect(contacts).toHaveLength(2);
  expect(contacts.map((c) => c.display.email).sort()).toEqual(["jane.doe2@acme.com", "jane.doe@acme.com"]);
  // The second Jane's email is bound to HER contact, not the first's.
  await ingestPeople([peopleRow({ Name: "J. Doe", Email: "jane.doe2@acme.com" })]);
  expect(await all("contacts")).toHaveLength(2);
});

test("a name-only sighting still reuses a contact in the same account", async () => {
  await ingestPeople([peopleRow({ Name: "Jane Doe", Email: "jane.doe@acme.com" })]);
  await ingestPeople([peopleRow({ Name: "Jane Doe" })]);
  expect(await all("contacts")).toHaveLength(1);
});


// ----------------------------------------------------------------- importCsv

const store = (text: string) => raw.run((ctx) => ctx.storage.store(new Blob([text])));
const csvOf = (n: number) =>
  ["Company Site,Company,Email,Name,Title", ...Array.from({ length: n }, (_, i) => `co${i}.com,Co ${i},p${i}@co${i}.com,Person ${i},Eng`)].join("\n");
// Scheduled continuations are the point of these tests, so time is faked and drained explicitly.
const drain = () => raw.finishAllScheduledFunctions(vi.runAllTimers);
const withFakeTimers = async (fn: () => Promise<void>) => {
  vi.useFakeTimers();
  try {
    await fn();
  } finally {
    vi.useRealTimers();
  }
};

test("importCsv stages the file; self-scheduled chunks (no auth identity) import it and report progress per chunk", () =>
  withFakeTimers(async () => {
    const out = await t.action(api.sources.import.importCsv, { runId, mappingId, storageId: await store(csvOf(1001)) });
    expect(out).toEqual({ rows: 1001, chunks: 3 });
    expect((await getRun()).rowsExpected).toBe(1001);
    expect(await all("importChunks")).toHaveLength(3);
    expect(await all("candidates")).toHaveLength(0); // nothing is inserted by the action itself

    // Walk the chain one scheduled step at a time and record the run's progress counter.
    const seen = new Set<number>();
    for (let i = 0; i < 200 && (await getRun()).status === "running"; i++) {
      vi.runOnlyPendingTimers();
      await raw.finishInProgressScheduledFunctions();
      seen.add((await getRun()).rowsProcessed);
    }
    expect([...seen]).toEqual(expect.arrayContaining([500, 1000, 1001]));
    const run = await getRun();
    expect(run).toMatchObject({ status: "completed", rowsProcessed: 1001, candidatesInserted: 1001, candidatesConsumed: 1001, candidatesRejected: 0 });
    expect(run.finishedAt).toBeDefined();
    expect(await all("importChunks")).toHaveLength(0); // staged chunks are removed as they are processed
  }), 120_000);

test("importCsv keeps rejected rows, numbered against the file, for after the run", () =>
  withFakeTimers(async () => {
    const lines = csvOf(3).split("\n");
    lines.splice(2, 0, ",,not-an-email,Bad,Eng"); // data row 1
    await t.action(api.sources.import.importCsv, { runId, mappingId, storageId: await store(lines.join("\n")) });
    await drain();
    expect(await getRun()).toMatchObject({ status: "completed", candidatesInserted: 3, rowsRejected: 1 });
    const rejections = await t.query(api.runs.queries.rejectionsForRun, { runId });
    expect(rejections.map((r) => r.row)).toEqual([1]);
    expect(rejections[0]!.errors.join(" ")).toContain("email");
  }));

test("a stalled import resumes from the first unprocessed chunk", () =>
  withFakeTimers(async () => {
    await t.action(api.sources.import.importCsv, { runId, mappingId, storageId: await store(csvOf(1001)) });
    // Process exactly the first chunk, then "lose" the rest of the chain.
    vi.runOnlyPendingTimers();
    await raw.finishInProgressScheduledFunctions();
    await raw.run(async (ctx) => {
      for (const s of await ctx.db.system.query("_scheduled_functions").collect()) {
        if (s.state.kind === "pending") await ctx.scheduler.cancel(s._id);
      }
    });
    expect((await getRun()).rowsProcessed).toBe(500);
    expect((await getRun()).status).toBe("running");
    await t.mutation(api.sources.import.resumeImport, { runId });
    await drain();
    expect(await getRun()).toMatchObject({ status: "completed", rowsProcessed: 1001, candidatesInserted: 1001 });
  }), 120_000);

test("importCsv fails with a named error before staging or inserting anything", async () => {
  const cases: Array<[string, string]> = [
    ["", "empty_file"],
    ["Company Site,Email,Email\na.com,a@a.com,b@a.com", "duplicate_headers: Email"],
    ["Company Site,Company\na.com,A", "missing_columns: Email, Name, Title"],
  ];
  for (const [text, message] of cases) {
    await expect(t.action(api.sources.import.importCsv, { runId, mappingId, storageId: await store(text) })).rejects.toThrow(message);
  }
  expect(await all("candidates")).toHaveLength(0);
  expect(await all("importChunks")).toHaveLength(0);
  expect((await getRun()).status).toBe("running");
});

test("importCsv on a header-only file completes the run with zero rows", async () => {
  const out = await t.action(api.sources.import.importCsv, { runId, mappingId, storageId: await store("Company Site,Company,Email,Name,Title\n") });
  expect(out).toEqual({ rows: 0, chunks: 0 });
  expect((await getRun()).status).toBe("completed");
});

test("importCsv refuses a second import into a run that already has one", async () => {
  await t.action(api.sources.import.importCsv, { runId, mappingId, storageId: await store(csvOf(1)) });
  await expect(t.action(api.sources.import.importCsv, { runId, mappingId, storageId: await store(csvOf(1)) })).rejects.toThrow("import_already_started");
});


test("the staging entry points validate the declared size and are not client-callable", async () => {
  for (const totalRows of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, MAX_IMPORT_ROWS + 1]) {
    await expect(
      raw.mutation(internal.sources.import.startStagedImport, { orgId, runId, totalRows, totalChunks: 1 }),
    ).rejects.toThrow("totalRows");
  }
  await expect(
    raw.mutation(internal.sources.import.startStagedImport, { orgId, runId, totalRows: 10, totalChunks: 0 }),
  ).rejects.toThrow("totalChunks");
  expect((await getRun()).rowsExpected).toBeUndefined();
  // The org travels as an internal argument, so a run from another org is still refused.
  const otherOrg = await raw.run((ctx) => ctx.db.insert("orgs", { name: "Org 2", createdAt: 0 }));
  await expect(
    raw.mutation(internal.sources.import.startStagedImport, { orgId: otherOrg, runId, totalRows: 1, totalChunks: 1 }),
  ).rejects.toThrow("run not found");
});

test("importCsv refuses an oversized file with a named error before reading it", async () => {
  const big = await raw.run((ctx) => ctx.storage.store(new Blob([new Uint8Array(MAX_IMPORT_BYTES + 1)])));
  await expect(t.action(api.sources.import.importCsv, { runId, mappingId, storageId: big })).rejects.toThrow("file_too_large");
  expect(await all("importChunks")).toHaveLength(0);
});

test("staged chunks are bounded by bytes as well as rows, and a single huge row is a named error", () =>
  withFakeTimers(async () => {
    // 20 rows with a ~60KB cell: 500 rows would be 1.2MB, over a document. Each cell is also an invalid
    // jobTitle (>2048 chars), so every row is rejected - which makes the row numbering checkable.
    const fat = "x".repeat(60_000);
    const lines = ["Company Site,Company,Email,Name,Title", ...Array.from({ length: 20 }, (_, i) => `co${i}.com,Co,p${i}@co.com,P,${fat}`)];
    await t.action(api.sources.import.importCsv, { runId, mappingId, storageId: await store(lines.join("\n")) });
    const chunks = await all("importChunks");
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) expect(JSON.stringify(c.rows).length).toBeLessThan(600_000);
    expect(chunks.reduce((n, c) => n + c.rows.length, 0)).toBe(20);
    await drain();
    expect(await getRun()).toMatchObject({ status: "completed", rowsProcessed: 20, rowsRejected: 20, candidatesInserted: 0 });
    const rows = (await t.query(api.runs.queries.rejectionsForRun, { runId })).map((r) => r.row);
    expect(rows).toEqual(Array.from({ length: 20 }, (_, i) => i));
  }), 60_000);

test("a single row too large to stage is a named error and stages nothing", async () => {
  const huge = ["Company Site,Company,Email,Name,Title", `a.com,Co,p@a.com,P,${"y".repeat(400_000)}`].join("\n");
  await expect(t.action(api.sources.import.importCsv, { runId, mappingId, storageId: await store(huge) })).rejects.toThrow("row_too_large");
  expect(await all("importChunks")).toHaveLength(0);
});

test("importRows refuses a run that already has a staged import, so the chain cannot be completed from under itself", () =>
  withFakeTimers(async () => {
    await t.action(api.sources.import.importCsv, { runId, mappingId, storageId: await store(csvOf(1001)) });
    await expect(t.mutation(api.sources.import.importRows, { runId, mappingId, rows: [jane()] })).rejects.toThrow("import_already_started");
    await drain();
    expect(await getRun()).toMatchObject({ status: "completed", rowsProcessed: 1001, chunksExpected: 3, chunksProcessed: 3 });
  }), 120_000);

test("ingestStep skips an unknown candidate id instead of losing the rest of its batch; the public entry still throws", async () => {
  const [good] = (await t.mutation(api.sources.import.importRows, { runId, mappingId, rows: [jane()] })).candidateIds;
  const gone = await raw.run(async (ctx) => {
    const id = await ctx.db.insert("candidates", {
      orgId, sourceId, dedupeHash: "domain:x.com|", status: "pending", contractVersion: CANDIDATE_CONTRACT_VERSION,
      candidate: { company: { domain: "x.com" }, acquisition: { acquiredAt: 1 } },
    });
    await ctx.db.delete(id);
    return id;
  });
  await expect(t.mutation(api.sources.ingest.ingestCandidates, { candidateIds: [gone, good!] })).rejects.toThrow("candidate not found");
  await raw.mutation(internal.sources.ingest.ingestStep, { orgId, candidateIds: [gone, good!] });
  expect((await all("candidates"))[0]!.status).toBe("consumed");
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


// ----------------------------------------------------------------- importCsv with .xlsx

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
/** A minimal workbook; every cell is an inline string except the date column, which is a date-formatted serial. */
function xlsxOf(table: string[][], opts: { sheets?: string[]; dateCol?: number } = {}): Uint8Array {
  const sheets = opts.sheets ?? ["Leads"];
  const cell = (v: string, r: number, c: number) =>
    opts.dateCol === c && r > 0 ? `<c r="${"ABCDEF"[c]}${r + 1}" s="1"><v>${v}</v></c>` : `<c r="${"ABCDEF"[c]}${r + 1}" t="inlineStr"><is><t>${v}</t></is></c>`;
  const rows = table.map((cells, r) => `<row r="${r + 1}">${cells.map((v, c) => cell(v, r, c)).join("")}</row>`).join("");
  const files: Record<string, Uint8Array> = {
    "xl/workbook.xml": strToU8(`<workbook ${NS}><sheets>${sheets.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<Relationships>${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://x/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rS" Type="http://x/styles" Target="styles.xml"/></Relationships>`,
    ),
    "xl/styles.xml": strToU8(`<styleSheet ${NS}><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`),
  };
  sheets.forEach((_, i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(`<worksheet ${NS}><sheetData>${i === 0 ? rows : ""}</sheetData></worksheet>`)));
  return zipSync(files);
}
const storeBytes = (bytes: Uint8Array) => raw.run((ctx) => ctx.storage.store(new Blob([bytes as BlobPart])));
const XLSX_HEAD = ["Company Site", "Company", "Email", "Name", "Title"];

test("importCsv reads an .xlsx the same way: sniffed from the bytes, imported through the same chain", () =>
  withFakeTimers(async () => {
    const table = [XLSX_HEAD, ...Array.from({ length: 1001 }, (_, i) => [`co${i}.com`, `Co ${i}`, `p${i}@co${i}.com`, `Person ${i}`, "Eng"])];
    const out = await t.action(api.sources.import.importCsv, { runId, mappingId, storageId: await storeBytes(xlsxOf(table)) });
    expect(out).toEqual({ rows: 1001, chunks: 3 });
    await drain();
    expect(await getRun()).toMatchObject({ status: "completed", rowsProcessed: 1001, candidatesInserted: 1001 });
  }), 120_000);

test("an .xlsx imports the same candidates as the equivalent CSV, with the Excel date arriving as the right acquiredAt", () =>
  withFakeTimers(async () => {
    const mappingWithDate = await t.mutation(api.sources.import.saveMapping, {
      name: "dated",
      columns: { ...COLUMNS, Acquired: "acquisition.acquiredAt" },
    });
    const table = [[...XLSX_HEAD, "Acquired"], ["a.com", "A", "a@a.com", "Ann", "Eng", "45658"]]; // 2025-01-01
    await t.action(api.sources.import.importCsv, { runId, mappingId: mappingWithDate, storageId: await storeBytes(xlsxOf(table, { dateCol: 5 })) });
    await drain();
    expect(await getRun()).toMatchObject({ status: "completed", candidatesInserted: 1, rowsRejected: 0 });
    const [cand] = await all("candidates");
    expect(cand!.candidate.acquisition.acquiredAt).toBe(Date.UTC(2025, 0, 1));
  }));

test("importCsv refuses unreadable or ambiguous workbooks by name, before staging anything", async () => {
  const ole = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
  const run = async (bytes: Uint8Array, sheet?: string) =>
    t.action(api.sources.import.importCsv, { runId, mappingId, storageId: await storeBytes(bytes), ...(sheet === undefined ? {} : { sheet }) });
  await expect(run(ole)).rejects.toThrow("unsupported_format: legacy .xls");
  await expect(run(xlsxOf([XLSX_HEAD], { sheets: ["Leads", "Other"] }))).rejects.toThrow("ambiguous_sheet");
  await expect(run(xlsxOf([XLSX_HEAD], { sheets: ["Leads", "Other"] }), "Nope")).rejects.toThrow("sheet_not_found");
  await expect(run(strToU8(csvOf(2)), "Leads")).rejects.toThrow("sheet_not_applicable");
  await expect(run(xlsxOf([["Company Site", "Email"], ["a.com", "a@a.com"]]))).rejects.toThrow("missing_columns: Company, Name, Title");
  expect(await all("candidates")).toHaveLength(0);
  expect(await all("importChunks")).toHaveLength(0);
  expect((await getRun()).status).toBe("running");
});

test("importCsv accepts a named sheet from a multi-sheet workbook", async () => {
  const out = await t.action(api.sources.import.importCsv, {
    runId,
    mappingId,
    storageId: await storeBytes(xlsxOf([XLSX_HEAD, ["a.com", "A", "a@a.com", "Ann", "Eng"]], { sheets: ["Leads", "Other"] })),
    sheet: "Leads",
  });
  expect(out).toEqual({ rows: 1, chunks: 1 });
});

test("a bad cell in a mapped column rejects that row only; a bad cell in an unmapped column is never read", () =>
  withFakeTimers(async () => {
    const withDate = await t.mutation(api.sources.import.saveMapping, { name: "dated2", columns: { ...COLUMNS, Acquired: "acquisition.acquiredAt" } });
    // Row 0: serial 60 (Excel's fictional 1900-02-29) in the MAPPED date column. Row 1: a valid date.
    const table = [[...XLSX_HEAD, "Acquired"], ["a.com", "A", "a@a.com", "Ann", "Eng", "60"], ["b.com", "B", "b@b.com", "Bob", "Eng", "45658"]];
    await t.action(api.sources.import.importCsv, { runId, mappingId: withDate, storageId: await storeBytes(xlsxOf(table, { dateCol: 5 })) });
    await drain();
    expect(await getRun()).toMatchObject({ status: "completed", rowsProcessed: 2, candidatesInserted: 1, rowsRejected: 1 });
    const rejections = await t.query(api.runs.queries.rejectionsForRun, { runId });
    expect(rejections).toHaveLength(1);
    expect(rejections[0]!.row).toBe(0);
    expect(rejections[0]!.errors).toEqual([
      'acquisition.acquiredAt: invalid_date: cell F2 holds 60, which is not a real calendar date (Excel serial 60 is its fictional 1900-02-29) (column "Acquired")',
    ]);
  }));

test("the same bad date in a column the mapping does not use imports cleanly", () =>
  withFakeTimers(async () => {
    const table = [[...XLSX_HEAD, "Acquired"], ["a.com", "A", "a@a.com", "Ann", "Eng", "60"]];
    await t.action(api.sources.import.importCsv, { runId, mappingId, storageId: await storeBytes(xlsxOf(table, { dateCol: 5 })) });
    await drain();
    expect(await getRun()).toMatchObject({ status: "completed", candidatesInserted: 1, rowsRejected: 0 });
  }));

// ----------------------------------------------------------------- a run that can never settle says so

test("a staged chunk whose mapping is gone fails the run instead of leaving it running forever", () =>
  withFakeTimers(async () => {
    await t.action(api.sources.import.importCsv, { runId, mappingId, storageId: await store(csvOf(1001)) });
    await raw.run((ctx) => ctx.db.delete(mappingId));
    await drain();
    const run = await getRun();
    expect(run.status).toBe("failed");
    expect(run.failureReason).toMatch(/^mapping_not_found: /);
    expect(run.finishedAt).toBeDefined();
    // The chain stopped at the bad chunk: nothing was imported and nothing was skipped past.
    expect(run.chunksProcessed).toBe(0);
    expect(await all("importChunks")).toHaveLength(3);
    expect(await all("candidates")).toHaveLength(0);
    // A failed run is terminal: it cannot be resumed, and finishing it does not turn it into a success.
    await expect(t.mutation(api.sources.import.resumeImport, { runId })).rejects.toThrow("run_not_active");
    await t.mutation(api.runs.mutations.finishRun, { runId });
    expect((await getRun()).status).toBe("failed");
  }), 120_000);

test("a staged chunk that went missing fails the run at the end of the chain", () =>
  withFakeTimers(async () => {
    await t.action(api.sources.import.importCsv, { runId, mappingId, storageId: await store(csvOf(1001)) });
    await raw.run(async (ctx) => {
      const lost = (await ctx.db.query("importChunks").collect()).find((c) => c.seq === 1);
      await ctx.db.delete(lost!._id);
    });
    await drain();
    const run = await getRun();
    expect(run.status).toBe("failed");
    expect(run.failureReason).toBe("chunks_missing: 2 of 3 staged chunks were imported");
  }), 120_000);
