import { ACQUISITION_STRING_FIELDS, COMPANY_STRING_FIELDS, PERSON_STRING_FIELDS, validateCandidate } from "./contract";
import type { NormalizedCandidate } from "./contract";

/**
 * A parser that meets a cell it cannot turn into a trustworthy string (an impossible date, a formula
 * with no cached value, an Excel error) emits this prefix plus the reason instead of a value. The
 * row is then rejected with that reason, rather than the file failing or a wrong value slipping in.
 */
export const CELL_ERROR_PREFIX = "#cell_error: ";

/**
 * The machine code at the front of a parser's cell-error reason (`invalid_number`, `invalid_date`...). The rest of the
 * reason can QUOTE the cell (`holds a non-numeric value "Bobby Tables"`), and a rejection is stored for good, so only
 * the code survives into it. Anything that is not a plain code becomes `unreadable_cell`.
 */
export function cellErrorCode(reason: string): string {
  const code = reason.split(":", 1)[0]!.trim();
  return /^[a-z][a-z_]{0,40}$/.test(code) ? code : "unreadable_cell";
}

export type ColumnPair = { column: string; target: string };

/** Every target a column may map to: `block.field` for each field the contract defines. */
export const MAPPING_TARGETS: ReadonlySet<string> = new Set([
  ...PERSON_STRING_FIELDS.map((f) => `person.${f}`),
  ...COMPANY_STRING_FIELDS.map((f) => `company.${f}`),
  "company.techStack",
  ...ACQUISITION_STRING_FIELDS.map((f) => `acquisition.${f}`),
  "acquisition.acquiredAt",
]);

/** Pure. Empty result means the mapping is usable. */
export function validateMapping(pairs: ColumnPair[]): string[] {
  const errors: string[] = [];
  if (pairs.length === 0) errors.push("a mapping needs at least one column");
  const byTarget = new Map<string, string[]>();
  for (const { column, target } of pairs) {
    if (column.trim() === "") errors.push("a mapped column name must not be empty");
    if (!MAPPING_TARGETS.has(target)) errors.push(`unknown target "${target}" for column "${column}"`);
    byTarget.set(target, [...(byTarget.get(target) ?? []), column]);
  }
  for (const [target, columns] of byTarget) {
    if (columns.length > 1) errors.push(`duplicate target ${target}: mapped from ${columns.join(", ")}`);
  }
  return errors;
}

/** Mapped columns that appear in none of the rows: a header problem, not a bad-row problem. */
export function missingColumns(rows: Array<Record<string, string>>, pairs: ColumnPair[]): string[] {
  if (rows.length === 0) return [];
  return pairs.filter(({ column }) => !rows.some((r) => column in r)).map((p) => p.column);
}

function parseAcquiredAt(text: string): number | null {
  const n = /^\d+$/.test(text) ? Number(text) : Date.parse(text);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Pure. Builds a candidate from one row. Values are trimmed but NOT normalized: the stored candidate
 * is the observation as received, and normalization happens when it is consumed. `acquiredAt` falls
 * back to `defaultAcquiredAt` (the run's start) when no column supplies it, so every chunk of one
 * import dates its leads identically.
 */
export function rowToCandidate(
  row: Record<string, string>,
  pairs: ColumnPair[],
  defaultAcquiredAt: number,
): { ok: true; candidate: NormalizedCandidate } | { ok: false; errors: string[] } {
  const blocks: Record<"person" | "company" | "acquisition", Record<string, unknown>> = { person: {}, company: {}, acquisition: {} };
  const errors: string[] = [];
  for (const { column, target } of pairs) {
    const text = (row[column] ?? "").trim();
    if (text === "") continue;
    if (text.startsWith(CELL_ERROR_PREFIX)) {
      // Rejections are persisted and outlive the file: name the column and a code, never the cell's text.
      errors.push(`${target}: ${cellErrorCode(text.slice(CELL_ERROR_PREFIX.length))} (column "${column}")`);
      continue;
    }
    const [block, field] = target.split(".") as ["person" | "company" | "acquisition", string];
    if (target === "company.techStack") {
      blocks.company.techStack = text.split(/[,;|]/).map((s) => s.trim()).filter(Boolean);
    } else if (target === "acquisition.acquiredAt") {
      const at = parseAcquiredAt(text);
      if (at === null) errors.push(`acquisition.acquiredAt: unreadable_date (column "${column}")`);
      else blocks.acquisition.acquiredAt = at;
    } else blocks[block][field] = text;
  }
  if (errors.length > 0) return { ok: false, errors };
  const input: Record<string, unknown> = { acquisition: { acquiredAt: defaultAcquiredAt, ...blocks.acquisition } };
  if (Object.keys(blocks.person).length > 0) input.person = blocks.person;
  if (Object.keys(blocks.company).length > 0) input.company = blocks.company;
  const checked = validateCandidate(input);
  return checked.ok ? { ok: true, candidate: checked.value } : { ok: false, errors: checked.errors };
}
