import { Inflate } from "fflate";
import { CELL_ERROR_PREFIX } from "./mapping";

/**
 * .xlsx reader for the import seam. Produces exactly what `parseCsv` produces (`{ headers, rows }` of
 * strings) so everything downstream stays format-agnostic. Pure (bytes in, table out) so it can be
 * tested without a deployment, and every failure is a named error, never a truncated dataset:
 * `not_xlsx`, `corrupt_archive`, `archive_too_large`, `too_many_rows`, `too_many_columns`,
 * `element_too_large`, `corrupt_workbook`, `ambiguous_sheet`, `sheet_not_found`, `not_a_worksheet`,
 * `empty_file`, `duplicate_headers`. These are properties of the file and fail the whole import.
 *
 * A bad CELL is not a bad file. An impossible date, a formula with no cached value or an Excel error
 * value becomes `CELL_ERROR_PREFIX + reason` in that cell, which the mapper turns into a rejection of
 * that one row (the reason names the cell). With `opts.columns` only the mapped columns' cells are
 * examined at all, so a typo in a column nobody imports cannot touch the import.
 *
 * DECOMPRESSION BOUND. An .xlsx is a zip, so the stored-size check on the upload says nothing about
 * what it inflates to. Every byte inflated for any part counts against one shared budget
 * (`MAX_XLSX_INFLATED_BYTES`) and the read aborts the moment it is spent: nothing is inflated "and
 * then checked". The zip central directory's declared sizes are only an early-out, never trusted.
 * Input is fed to the inflater in small slices (`INFLATE_SLICE`) because a deflate stream expands at
 * most ~1032:1, which caps how much one step can allocate before the budget check sees it. The sheet
 * and the shared strings are consumed as a stream (one row / one string at a time), so memory is
 * the table being built, not the XML. The row cap is enforced while rows are produced.
 *
 * Library: fflate (pure JS, no Node APIs, runs in the V8 isolate) supplies only the deflate inflater.
 * The zip directory is read here, because the streaming unzip in fflate trusts local headers and
 * mishandles data descriptors, and because we need the central directory's sizes up front.
 */

/**
 * Total bytes inflated across every part read (workbook, rels, styles, shared strings, the sheet). 64 MiB.
 *
 * INTERACTION WITH THE ROW CAP: cell XML is ~30 bytes per cell, so 200,000 rows (MAX_IMPORT_ROWS)
 * x ~20 columns is ~120 MB inflated. On anything but a narrow sheet (roughly 10 columns or fewer) this
 * budget fires (`archive_too_large`) before the row cap does. Both errors are named and tell the
 * caller to split the file or export CSV; 200,000 rows is only reachable for narrow sheets.
 */
export const MAX_XLSX_INFLATED_BYTES = 64 * 1024 * 1024;
/** A sane workbook has tens of entries; a zip with more is hostile or not a workbook. */
const MAX_ENTRIES = 5_000;
/** Workbook, rels and styles are small by nature; none may exceed this even inside the total budget. */
const MAX_SMALL_PART_BYTES = 4 * 1024 * 1024;
/** One `<row>` or `<si>` larger than this (in characters) is refused rather than buffered. */
const MAX_ELEMENT_CHARS = 8 * 1024 * 1024;
/** Columns with data. Excel allows 16384; a CRM export with more than this is not a table we can map. */
export const MAX_XLSX_COLUMNS = 1_024;
const INFLATE_SLICE = 4 * 1024;

export type SniffedFormat = "xlsx" | "xls" | "csv";

/**
 * Decides the format from content, not from a file name or a client-supplied content type. "xls"
 * means an OLE2 container: the legacy binary format, or a password-protected .xlsx (which Excel
 * wraps in OLE2). Neither can be read here.
 */
export function sniffFormat(head: Uint8Array): SniffedFormat {
  const at = (i: number) => head[i] ?? -1;
  if (at(0) === 0x50 && at(1) === 0x4b && (at(2) === 0x03 || at(2) === 0x05 || at(2) === 0x07)) return "xlsx";
  const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  if (ole.every((b, i) => at(i) === b)) return "xls";
  return "csv";
}

export type XlsxOptions = {
  /** Rows beyond this (data rows, header excluded) throw `too_many_rows` as soon as they are seen. */
  maxRows: number;
  /** Header names the caller will read. When given, cells in other columns are never interpreted. */
  columns?: readonly string[];
  /** Sheet to import. Required when the workbook has more than one visible sheet. */
  sheet?: string;
  /** Test seam; production uses MAX_XLSX_INFLATED_BYTES. */
  maxInflatedBytes?: number;
};

// ------------------------------------------------------------------ zip (central directory + bounded inflate)

type Entry = { name: string; method: number; csize: number; usize: number; offset: number };

function listEntries(b: Uint8Array): Map<string, Entry> {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not_xlsx: not a zip archive (no end-of-central-directory record)");
  const count = dv.getUint16(eocd + 10, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error("corrupt_archive: zip64 archives are not supported");
  if (count > MAX_ENTRIES) throw new Error(`archive_too_large: ${count} entries exceeds the ${MAX_ENTRIES} entry limit`);
  const names = new TextDecoder();
  const out = new Map<string, Entry>();
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > b.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error("corrupt_archive: bad central directory");
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const skip = nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
    const offset = dv.getUint32(p + 42, true);
    if (p + 46 + skip > b.length) throw new Error("corrupt_archive: bad central directory");
    if (flags & 1) throw new Error("corrupt_archive: encrypted entries are not supported");
    if (csize === 0xffffffff || usize === 0xffffffff) throw new Error("corrupt_archive: zip64 entries are not supported");
    const name = names.decode(b.subarray(p + 46, p + 46 + nameLen));
    if (out.has(name)) throw new Error(`corrupt_archive: duplicate entry ${name}`); // which one wins would be ambiguous
    out.set(name, { name, method, csize, usize, offset });
    p += 46 + skip;
  }
  return out;
}

/** Inflated-byte budget shared by every read of one workbook. */
class Budget {
  constructor(
    readonly total: number,
    public left: number = total,
  ) {}
  spend(n: number): void {
    this.left -= n;
    if (this.left < 0) {
      throw new Error(
        `archive_too_large: the workbook inflates past the ${this.total} byte limit (a compressed file can expand far beyond its size); split it or export CSV`,
      );
    }
  }
}

/** Inflates one entry, handing each chunk to `sink`. Every output byte is charged to `budget` as it appears. */
function readEntry(b: Uint8Array, e: Entry, budget: Budget, sink: (chunk: Uint8Array) => void, partMax = Infinity): void {
  if (e.usize > budget.left || e.usize > partMax) {
    throw new Error(`archive_too_large: ${e.name} declares ${e.usize} bytes (limit ${Math.min(budget.left, partMax)})`);
  }
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (e.offset + 30 > b.length || dv.getUint32(e.offset, true) !== 0x04034b50) throw new Error(`corrupt_archive: bad local header for ${e.name}`);
  const start = e.offset + 30 + dv.getUint16(e.offset + 26, true) + dv.getUint16(e.offset + 28, true);
  if (start + e.csize > b.length) throw new Error(`corrupt_archive: ${e.name} is truncated`);
  const data = b.subarray(start, start + e.csize);

  let produced = 0;
  let named: Error | undefined;
  const take = (chunk: Uint8Array) => {
    produced += chunk.length;
    try {
      budget.spend(chunk.length);
      if (produced > partMax) throw new Error(`archive_too_large: ${e.name} exceeds ${partMax} bytes`);
    } catch (err) {
      named = err as Error;
      throw named;
    }
    sink(chunk);
  };
  try {
    if (e.method === 0) {
      for (let i = 0; i < data.length; i += INFLATE_SLICE) take(data.subarray(i, i + INFLATE_SLICE));
    } else if (e.method === 8) {
      const inf = new Inflate((chunk) => take(chunk));
      for (let i = 0; i < data.length; i += INFLATE_SLICE) inf.push(data.subarray(i, i + INFLATE_SLICE), false);
      inf.push(new Uint8Array(0), true);
    } else {
      throw new Error(`corrupt_archive: ${e.name} uses unsupported compression method ${e.method}`);
    }
  } catch (err) {
    if (named) throw named;
    if (err instanceof Error && /^[a-z_]+: /.test(err.message)) throw err;
    throw new Error(`corrupt_archive: ${e.name} cannot be inflated`);
  }
  if (produced !== e.usize) throw new Error(`corrupt_archive: ${e.name} inflated to ${produced} bytes, directory says ${e.usize}`);
}

function streamText(b: Uint8Array, e: Entry, budget: Budget, onText: (s: string) => void, partMax?: number): void {
  const dec = new TextDecoder("utf-8");
  readEntry(b, e, budget, (c) => onText(dec.decode(c, { stream: true })), partMax);
  onText(dec.decode());
}

function readSmallText(b: Uint8Array, e: Entry, budget: Budget): string {
  let s = "";
  streamText(b, e, budget, (t) => (s += t), MAX_SMALL_PART_BYTES);
  return s;
}

// ------------------------------------------------------------------ xml helpers (the OOXML subset we need)

/** Incrementally cuts complete `<tag ...>...</tag>` (or self-closed) elements out of streamed text. */
class ElementScanner {
  private buf = "";
  private closeFrom = 0; // where to resume looking for the close tag in an element still arriving
  constructor(private readonly tag: string) {}

  feed(text: string, emit: (xml: string) => void): void {
    this.buf += text;
    const close = `</${this.tag}>`;
    let pos = 0;
    for (;;) {
      const start = this.open(pos);
      if (start < 0) {
        pos = Math.max(pos, this.buf.length - this.tag.length - 2); // keep a possible partial "<ta"
        break;
      }
      const gt = tagEnd(this.buf, start);
      if (gt < 0) {
        pos = start;
        break;
      }
      if (this.buf[gt - 1] === "/") {
        emit(this.buf.slice(start, gt + 1));
        pos = gt + 1;
        continue;
      }
      const end = this.buf.indexOf(close, Math.max(gt + 1, start + this.closeFrom));
      if (end < 0) {
        if (this.buf.length - start > MAX_ELEMENT_CHARS) {
          throw new Error(`element_too_large: a <${this.tag}> element exceeds ${MAX_ELEMENT_CHARS} characters`);
        }
        this.closeFrom = Math.max(gt + 1 - start, this.buf.length - start - close.length + 1);
        pos = start;
        break;
      }
      if (end + close.length - start > MAX_ELEMENT_CHARS) {
        throw new Error(`element_too_large: a <${this.tag}> element exceeds ${MAX_ELEMENT_CHARS} characters`);
      }
      emit(this.buf.slice(start, end + close.length));
      this.closeFrom = 0;
      pos = end + close.length;
    }
    this.buf = this.buf.slice(pos);
  }

  private open(from: number): number {
    const needle = `<${this.tag}`;
    for (let i = this.buf.indexOf(needle, from); i >= 0; i = this.buf.indexOf(needle, i + 1)) {
      const next = this.buf[i + needle.length];
      if (next === undefined) return -1;
      if (next === " " || next === ">" || next === "/" || next === "\n" || next === "\t" || next === "\r") return i;
    }
    return -1;
  }
}

/** Index of the `>` that ends the tag starting at `start`, skipping quoted attribute values; -1 if not here yet. */
function tagEnd(s: string, start: number): number {
  let q = "";
  for (let i = start; i < s.length; i++) {
    const c = s[i]!;
    if (q) {
      if (c === q) q = "";
    } else if (c === '"' || c === "'") q = c;
    else if (c === ">") return i;
  }
  return -1;
}

function unescapeXml(s: string): string {
  if (!s.includes("&") && !s.includes("_x")) return s;
  const xml = s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (m, e: string) => {
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "amp") return "&";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    const cp = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m;
  });
  // ST_Xstring: control characters travel as _xHHHH_ (and a literal "_x0041_" as _x005F_x0041_).
  return xml.replace(/_x([0-9a-fA-F]{4})_/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
}

/**
 * Attributes of one open tag, read in a single left-to-right walk (every character is visited a bounded
 * number of times, and `i` always advances). A regex with a greedy name prefix such as `[\w:.-]+\s*=`
 * backtracks quadratically on a long run of name characters with no `=`.
 */
function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const isSpace = (c: string) => c === " " || c === "\n" || c === "\t" || c === "\r";
  const n = tag.length;
  let i = 1; // past "<"
  while (i < n && !isSpace(tag[i]!) && tag[i] !== ">" && tag[i] !== "/") i++; // the tag name
  while (i < n) {
    while (i < n && (isSpace(tag[i]!) || tag[i] === "/")) i++;
    if (i >= n || tag[i] === ">") break;
    const start = i;
    while (i < n && !isSpace(tag[i]!) && tag[i] !== "=" && tag[i] !== ">" && tag[i] !== "/") i++;
    const name = tag.slice(start, i);
    while (i < n && isSpace(tag[i]!)) i++;
    if (tag[i] !== "=") {
      if (i === start) i++; // a stray character: step over it
      continue; // an attribute with no value (not valid XML): ignored
    }
    i++;
    while (i < n && isSpace(tag[i]!)) i++;
    const q = tag[i];
    if (q !== '"' && q !== "'") continue;
    const end = tag.indexOf(q, i + 1);
    if (end < 0) break;
    if (name !== "") out[name] = unescapeXml(tag.slice(i + 1, end));
    i = end + 1;
  }
  return out;
}

/** The opening tag of an element as written, e.g. `<c r="A1" s="2">`. */
function openTag(xml: string): string {
  return xml.slice(0, tagEnd(xml, 0) + 1);
}

/*
 * WORK MUST BE LINEAR BY CONSTRUCTION. The byte budget bounds bytes, not work: a ~1 KB upload of repeated
 * "<c" tokens burned 61.7 s in a lazy regex, and each later hazard was the same mistake in a new place
 * (a scanner that does not advance past what it consumed, or one that re-scans to the end for every
 * unterminated candidate). So every element scan in this module goes through `nextElement`, the single
 * primitive that guarantees: the candidate is a real tag, its open tag is bounded, a required close either
 * exists or the scan THROWS, and the returned cursor is strictly past everything consumed. Callers
 * cannot get any of those wrong because they never see the raw indices. Regexes are only used on input
 * already bounded in length.
 */

/** A longest legitimate open tag is a few hundred characters; anything longer is not worth interpreting. */
const MAX_TAG_CHARS = 8 * 1024;
/** Excel's own column limit: a row with more `<c>` than this is not a spreadsheet row. */
const MAX_CELLS_PER_ROW = 16_384;
/** Far above any real part (Excel allows 64,000 cell formats, 255 sheets); a cap on structural tag count. */
const MAX_STRUCTURAL_TAGS = 200_000;

/** Index of the next `<tag` that is really that tag (followed by whitespace, `/` or `>`), or -1. */
function nextOpen(xml: string, tag: string, from: number): number {
  const needle = `<${tag}`;
  for (let i = xml.indexOf(needle, from); i >= 0; i = xml.indexOf(needle, i + 1)) {
    const c = xml[i + needle.length];
    if (c === " " || c === ">" || c === "/" || c === "\n" || c === "\t" || c === "\r") return i;
  }
  return -1;
}

type Scanned = {
  /** Where the element starts in the text scanned. */
  start: number;
  /** The open tag as written. */
  open: string;
  /** Content between the tags; undefined for a self-closed element or when no close was asked for. */
  inner: string | undefined;
  /** Where to resume: always greater than `start`, and past everything this element consumed. */
  next: number;
};

/**
 * The scan primitive. Finds the next `<tag` at or after `from`; null if none. Throws `fail(...)` if its
 * open tag is unterminated or longer than MAX_TAG_CHARS, or (when `close`) if a non-self-closed element
 * has no `</tag>`. A scan never returns a candidate it did not fully consume, and never retries one.
 */
function nextElement(xml: string, tag: string, from: number, close: boolean, fail: (what: string) => Error): Scanned | null {
  const start = nextOpen(xml, tag, from);
  if (start < 0) return null;
  const gt = tagEnd(xml, start);
  if (gt < 0 || gt - start > MAX_TAG_CHARS) throw fail(`an unterminated or oversized <${tag}> tag`);
  const open = xml.slice(start, gt + 1);
  if (!close || xml[gt - 1] === "/") return { start, open, inner: undefined, next: gt + 1 };
  const end = xml.indexOf(`</${tag}>`, gt + 1);
  if (end < 0) throw fail(`<${tag}> is never closed`);
  return { start, open, inner: xml.slice(gt + 1, end), next: end + tag.length + 3 };
}

const structural = (what: string) => new Error(`corrupt_workbook: ${what}`);
const badCell = (what: string) => new CellError(`malformed_cell: ${what}`);

/** Every `<tag ...>` open tag in `xml` (a small structural part), as written. Unterminated or oversized is corrupt. */
function tagsOf(xml: string, tag: string): string[] {
  const out: string[] = [];
  for (let el = nextElement(xml, tag, 0, false, structural); el; el = nextElement(xml, tag, el.next, false, structural)) {
    if (out.length >= MAX_STRUCTURAL_TAGS) throw structural(`more than ${MAX_STRUCTURAL_TAGS} <${tag}> tags`);
    out.push(el.open);
  }
  return out;
}

/** Text of the first `<tag>..</tag>` child ("" for a self-closed one), undefined if absent. */
function childText(inner: string, tag: string): string | undefined {
  const el = nextElement(inner, tag, 0, true, badCell);
  return el ? (el.inner ?? "") : undefined;
}

/** The `<c>` elements of a row body, split by index so a legal `>` inside an attribute value cannot mis-split one. */
function splitCells(row: string, from: number): Array<{ open: string; inner: string | undefined }> {
  const out: Array<{ open: string; inner: string | undefined }> = [];
  for (let el = nextElement(row, "c", from, true, structural); el; el = nextElement(row, "c", el.next, true, structural)) {
    if (out.length >= MAX_CELLS_PER_ROW) throw new Error(`too_many_columns: a row has more than ${MAX_CELLS_PER_ROW} cells`);
    out.push({ open: el.open, inner: el.inner });
  }
  return out;
}

/** Concatenated text runs of a shared string / inline string, excluding phonetic (`rPh`) runs. One linear pass. */
function richText(xml: string): string {
  let s = "";
  let pos = 0;
  let t: Scanned | null | undefined; // undefined = not looked for yet; null = none left
  let p: Scanned | null | undefined;
  for (;;) {
    if (t === undefined || (t !== null && t.start < pos)) t = nextElement(xml, "t", pos, true, badCell);
    if (p === undefined || (p !== null && p.start < pos)) p = nextElement(xml, "rPh", pos, true, badCell);
    const phonetic = p !== null && (t === null || p.start < t.start);
    const el = phonetic ? p : t;
    if (el === null || el === undefined) return s;
    if (!phonetic && el.inner !== undefined) s += unescapeXml(el.inner);
    pos = el.next;
  }
}

// ------------------------------------------------------------------ numbers and dates

/** Exact decimal text of an Excel number, never routed through a float, never in exponent form. */
function numberText(raw: string, where: string): string {
  const t = raw.trim();
  // Real numbers are at most ~25 characters. The cap also bounds the regex work below on hostile input.
  if (t.length > 64) throw new CellError(`invalid_number: ${where} holds a ${t.length} character number`);
  if (/^-?\d+(\.\d+)?$/.test(t)) return t;
  const m = /^([-+]?)(\d*)\.?(\d*)[eE]([-+]?\d+)$/.exec(t);
  if (!m || (m[2] === "" && m[3] === "")) throw new CellError(`invalid_number: ${where} holds a non-numeric value "${t}"`);
  const exp = parseInt(m[4]!, 10);
  if (Math.abs(exp) > 400) throw new CellError(`invalid_number: ${where} has an absurd exponent`);
  const digits = m[2]! + m[3]!;
  const point = m[2]!.length + exp;
  let int: string;
  let frac: string;
  if (point <= 0) {
    int = "0";
    frac = "0".repeat(-point) + digits;
  } else if (point >= digits.length) {
    int = digits + "0".repeat(point - digits.length);
    frac = "";
  } else {
    int = digits.slice(0, point);
    frac = digits.slice(point);
  }
  int = int.replace(/^0+(?=\d)/, "");
  // /0+$/ is quadratic on a long run of zeros followed by a non-zero. What bounds `frac` is the exponent clamp above
  // (|exp| <= 400 gives at most ~464 characters), not the 64-character length cap. Keep that clamp.
  frac = frac.replace(/0+$/, "");
  const sign = m[1] === "-" && (/[1-9]/.test(int) || frac !== "") ? "-" : "";
  return sign + int + (frac ? "." + frac : "");
}

const BUILTIN_DATE_IDS = new Set([14, 15, 16, 17, 22, ...range(27, 36), ...range(50, 58)]);
const BUILTIN_TIME_IDS = new Set([18, 19, 20, 21, 45, 46, 47]);
function range(a: number, b: number): number[] {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

type NumFmt = { kind: "date" | "time" | null; code: string | undefined };

/** A cell is a date because of its number format, never its value. */
function classifyFormat(id: number, code: string | undefined): NumFmt {
  if (code !== undefined && code.length > 256) return { kind: null, code: undefined }; // not a real format; also bounds regex work
  if (code === undefined) {
    if (BUILTIN_DATE_IDS.has(id)) return { kind: "date", code };
    if (BUILTIN_TIME_IDS.has(id)) return { kind: "time", code };
    return { kind: null, code };
  }
  const first = code
    .split(";")[0]!
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "")
    .replace(/[_*]./g, "")
    .replace(/\[(?![hms]+\])[^\]]*\]/gi, ""); // [Red], [$-409], [>100]: not tokens; [h] [mm] [ss] are elapsed time
  if (/[yd]/i.test(first)) return { kind: "date", code };
  if (/[hs]/i.test(first)) return { kind: "time", code };
  if (/m/i.test(first)) return { kind: "date", code }; // month-only formats ("mmm")
  return { kind: null, code };
}

/**
 * Applies a digit-placeholder format ("00000", "00000-0000", "(000) 000-0000") to a non-negative
 * integer so a zip code or phone keeps the leading zeros and punctuation Excel displays. Anything
 * not purely that shape (decimals, %, thousands, sections with conditions) is left as plain digits.
 */
function applyDigitMask(digits: string, code: string): string {
  if (!/^\d+$/.test(digits)) return digits;
  const section = code.split(";")[0]!;
  if (/\[[<>=]/.test(code) || /[.,%eE@/]/.test(section.replace(/"[^"]*"/g, "").replace(/\\./g, ""))) return digits;
  const tokens: Array<{ ph: boolean; text: string }> = [];
  for (let i = 0; i < section.length; i++) {
    const c = section[i]!;
    if (c === '"') {
      const end = section.indexOf('"', i + 1);
      if (end < 0) return digits;
      tokens.push({ ph: false, text: section.slice(i + 1, end) });
      i = end;
    } else if (c === "\\" || c === "_") {
      if (c === "\\" && i + 1 < section.length) tokens.push({ ph: false, text: section[i + 1]! });
      i++;
    } else if (c === "0" || c === "#" || c === "?") tokens.push({ ph: true, text: c });
    else if ("-()+ :$".includes(c)) tokens.push({ ph: false, text: c });
    else return digits;
  }
  const slots = tokens.filter((t) => t.ph).length;
  if (slots === 0) return digits;
  const extra = digits.length > slots ? digits.slice(0, digits.length - slots) : ""; // more digits than slots: they lead the first slot
  const d = digits.slice(extra.length);
  const first = tokens.findIndex((t) => t.ph);
  let di = d.length;
  const out: string[] = [];
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i]!;
    if (!t.ph) out.unshift(t.text);
    else {
      const digit = di > 0 ? d[--di]! : t.text === "0" ? "0" : t.text === "?" ? " " : "";
      out.unshift(i === first ? extra + digit : digit);
    }
  }
  return out.join("");
}

/** A problem with one cell's content (as opposed to the file's structure). Caught per cell and emitted as a row-rejecting marker. */
class CellError extends Error {}

const DAY_MS = 86_400_000;

function toIso(serial: number, date1904: boolean, where: string): string {
  let days = Math.floor(serial);
  let secs = Math.round((serial - days) * 86_400);
  if (secs === 86_400) {
    days += 1;
    secs = 0;
  }
  // 1900 system: serial 1 = 1900-01-01, and serial 60 is the nonexistent 1900-02-29 Excel inherited from Lotus.
  let unixDays = Number.NaN;
  if (date1904) {
    if (days >= 0 && days <= 2957003) unixDays = days - 24107;
  } else if (days >= 61 && days <= 2958465) unixDays = days - 25569;
  else if (days >= 1 && days <= 59) unixDays = days - 25568;
  if (!Number.isFinite(serial) || Number.isNaN(unixDays)) {
    throw new CellError(`invalid_date: ${where} holds ${serial}, which is not a real calendar date (Excel serial 60 is its fictional 1900-02-29)`);
  }
  const d = new Date(unixDays * DAY_MS);
  const day = d.toISOString().slice(0, 10);
  if (secs === 0) return day;
  const hh = String(Math.floor(secs / 3600)).padStart(2, "0");
  const mm = String(Math.floor((secs % 3600) / 60)).padStart(2, "0");
  const ss = String(secs % 60).padStart(2, "0");
  return `${day}T${hh}:${mm}:${ss}Z`;
}

function toDuration(serial: number): string {
  const total = Math.round(serial * 86_400);
  const hh = String(Math.floor(total / 3600)).padStart(2, "0");
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

// ------------------------------------------------------------------ workbook

type SheetRef = { name: string; hidden: boolean; target: string; type: string };

function resolveTarget(target: string): string {
  const parts = (target.startsWith("/") ? target.slice(1) : `xl/${target}`).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p !== "." && p !== "") out.push(p);
  }
  return out.join("/");
}

function colIndex(ref: string): number {
  let n = 0;
  for (const c of ref) {
    const k = c.charCodeAt(0);
    if (k < 65 || k > 90) break;
    n = n * 26 + (k - 64);
  }
  return n - 1;
}

/**
 * Parses one worksheet of an .xlsx into `{ headers, rows }` of strings, matching `parseCsv`:
 *
 * - SHEET: `opts.sheet` by exact name, else the only visible sheet. A workbook with several visible
 *   sheets and no name throws `ambiguous_sheet` rather than guessing; an unknown name throws
 *   `sheet_not_found`. Hidden sheets are never picked by default.
 * - STRINGS stay exactly as stored. NUMBERS are emitted as the exact decimal text stored in the file
 *   (no float round trip, no exponent form), so 1555010203 never becomes 1.555010203e9. Excel does
 *   not store the displayed text of a number, so the one display rule we can honour is a
 *   digit-placeholder format ("00000", "00000-0000", "(000) 000-0000"), applied to integers so zip
 *   codes and phones keep their leading zeros and punctuation. Text-typed cells are untouched.
 * - DATES: a numeric cell is a date or time iff its number format says so (built-in ids 14-17, 22,
 *   27-36, 50-58 and custom codes with y/d/m tokens; time-only for h/s). Dates come out as
 *   `YYYY-MM-DD`, or `YYYY-MM-DDTHH:MM:SSZ` (UTC) when the cell carries a time, which
 *   `Date.parse` reads unambiguously; time-only cells as `HH:MM:SS`. The workbook's 1900 or 1904
 *   epoch is honoured, 1900 leap-year bug included. A date-formatted cell that is not a real date
 *   (serial 60, zero, negative) is a bad CELL (`invalid_date`), because the mapper would otherwise
 *   read a bare "60" as epoch milliseconds. ISO date cells (t="d") pass through.
 * - BOOLEANS are TRUE/FALSE; Excel error values (#N/A) are bad cells (`error_value`).
 * - FORMULAS yield the cached value; a formula with no cached value is a bad cell (`uncached_formula`).
 * - BAD CELLS (also `invalid_number`, `invalid_shared_string`, `malformed_cell`) never throw: see CELL_ERROR_PREFIX.
 *
 * KNOWN, INTENTIONAL DIVERGENCE FROM CSV: `parseCsv` keeps a `,,` line as a record (the mapper then
 * rejects it, so it shows up as a rejected row), while an all-blank spreadsheet row has no cells at all
 * and is dropped here. Row numbers therefore count non-blank rows only, as the CSV reader's do for
 * blank lines but not for `,,` lines.
 * - SHAPE: fully blank rows are dropped (as blank lines are in CSV) and the first non-blank row is
 *   the header. Headers are trimmed; a blank interior header stays "" (unmappable, as in CSV) and
 *   trailing blank headers are dropped. Merged cells keep their value in the top-left cell only.
 *   Rows are not padded to the header width, as in CSV.
 */
export function parseXlsx(bytes: Uint8Array, opts: XlsxOptions): { headers: string[]; rows: string[][] } {
  const budget = new Budget(opts.maxInflatedBytes ?? MAX_XLSX_INFLATED_BYTES);
  const entries = listEntries(bytes);
  const need = (name: string): Entry => {
    const e = entries.get(name);
    if (!e) throw new Error(`not_xlsx: the archive has no ${name}`);
    return e;
  };

  // --- workbook: sheets, epoch, relationships
  const wbXml = readSmallText(bytes, need("xl/workbook.xml"), budget);
  const relsEntry = entries.get("xl/_rels/workbook.xml.rels");
  if (!relsEntry) throw new Error("not_xlsx: the archive has no xl/_rels/workbook.xml.rels");
  const rels = new Map<string, { target: string; type: string }>();
  for (const tag of tagsOf(readSmallText(bytes, relsEntry, budget), "Relationship")) {
    const a = attrs(tag);
    if (a.Id && a.Target) rels.set(a.Id, { target: a.Target, type: a.Type ?? "" });
  }
  const date1904 = /^(1|true)$/i.test(attrs(tagsOf(wbXml, "workbookPr")[0] ?? "").date1904 ?? "");
  const sheets: SheetRef[] = [];
  for (const tag of tagsOf(wbXml, "sheet")) {
    const a = attrs(tag);
    const rid = Object.entries(a).find(([k]) => k === "id" || k.endsWith(":id"))?.[1];
    const rel = rid ? rels.get(rid) : undefined;
    if (!a.name || !rel) throw new Error("corrupt_workbook: a sheet has no name or relationship");
    sheets.push({ name: a.name, hidden: a.state === "hidden" || a.state === "veryHidden", target: resolveTarget(rel.target), type: rel.type });
  }
  if (sheets.length === 0) throw new Error("empty_file: the workbook has no sheets");

  let sheet: SheetRef;
  if (opts.sheet !== undefined) {
    const hit = sheets.find((s) => s.name === opts.sheet);
    if (!hit) throw new Error(`sheet_not_found: "${opts.sheet}" (sheets: ${sheets.map((s) => s.name).join(", ")})`);
    sheet = hit;
  } else {
    const visible = sheets.filter((s) => !s.hidden);
    if (visible.length !== 1) {
      throw new Error(
        `ambiguous_sheet: the workbook has ${visible.length} visible sheets (${visible.map((s) => s.name).join(", ")}); name the one to import`,
      );
    }
    sheet = visible[0]!;
  }
  if (!sheet.type.endsWith("/worksheet")) throw new Error(`not_a_worksheet: "${sheet.name}" is not a worksheet (chart sheet?)`);

  // --- styles: number format per cell style
  const part = (suffix: string) => [...rels.values()].find((r) => r.type.endsWith(suffix));
  const stylesRel = part("/styles");
  const fmts: NumFmt[] = [];
  if (stylesRel) {
    const e = entries.get(resolveTarget(stylesRel.target));
    if (e) {
      const styles = readSmallText(bytes, e, budget);
      const custom = new Map<number, string>();
      for (const tag of tagsOf(styles, "numFmt")) {
        const a = attrs(tag);
        if (a.numFmtId !== undefined && a.formatCode !== undefined) custom.set(Number(a.numFmtId), a.formatCode);
      }
      let xfs = "";
      try {
        xfs = childText(styles, "cellXfs") ?? "";
      } catch {
        throw new Error("corrupt_workbook: xl/styles.xml has a malformed <cellXfs>");
      }
      for (const tag of tagsOf(xfs, "xf")) {
        const id = Number(attrs(tag).numFmtId ?? 0);
        fmts.push(classifyFormat(id, custom.get(id)));
      }
    }
  }

  // --- shared strings (streamed; one <si> at a time)
  const shared: string[] = [];
  const sstRel = part("/sharedStrings");
  if (sstRel) {
    const e = entries.get(resolveTarget(sstRel.target));
    if (e) {
      const scan = new ElementScanner("si");
      streamText(bytes, e, budget, (t) =>
        scan.feed(t, (xml) => {
          try {
            shared.push(richText(xml));
          } catch {
            throw new Error("corrupt_workbook: xl/sharedStrings.xml has a malformed string item");
          }
        }),
      );
    }
  }

  // --- the sheet, streamed row by row
  const sheetEntry = entries.get(sheet.target);
  if (!sheetEntry) throw new Error(`corrupt_workbook: the archive has no ${sheet.target} for "${sheet.name}"`);

  const rows: string[][] = [];
  let headers: string[] | null = null;

  const cellValue = (inner: string, a: Record<string, string>, where: string): string => {
    const t = a.t ?? "n";
    if (t === "inlineStr") return richText(inner);
    const v = childText(inner, "v");
    // A numeric formula result is never empty, so no <v> (or an empty one, as openpyxl writes) means it was never calculated.
    // A text formula (t="str") may legitimately cache "".
    if (nextOpen(inner, "f", 0) >= 0 && (v === undefined || (t === "n" && v.trim() === ""))) {
      throw new CellError(`uncached_formula: ${where} has a formula but no cached value; open and re-save the workbook in Excel, or export CSV`);
    }
    if (v === undefined) return "";
    if (t === "s") {
      const s = shared[Number(v)];
      if (s === undefined) throw new CellError(`invalid_shared_string: ${where} points at missing shared string ${v}`);
      return s;
    }
    if (t === "str") return unescapeXml(v);
    if (t === "e") throw new CellError(`error_value: ${where} holds the Excel error ${unescapeXml(v)}`);
    if (t === "d") return unescapeXml(v).trim();
    if (t === "b") return v.trim() === "1" ? "TRUE" : "FALSE";
    if (v.trim() === "") return "";
    const text = numberText(unescapeXml(v), where);
    const fmt = fmts[Number(a.s ?? 0)];
    if (fmt?.kind === "date") return toIso(Number(text), date1904, where);
    if (fmt?.kind === "time") return toDuration(Number(text));
    return fmt?.code !== undefined && !text.startsWith("-") ? applyDigitMask(text, fmt.code) : text;
  };

  /**
   * Would this cell come out blank if interpreted? Mirrors cellValue's blank outcomes WITHOUT converting
   * anything, so an unmapped cell counts as data exactly when the interpreted path would keep its row
   * (row numbers must not depend on whether `columns` was passed). A cell cellValue would turn into a
   * marker is data.
   */
  const blankCell = (inner: string, a: Record<string, string>): boolean => {
    const t = a.t ?? "n";
    try {
      if (t === "inlineStr") return richText(inner).trim() === "";
      const v = childText(inner, "v");
      if (nextOpen(inner, "f", 0) >= 0 && (v === undefined || (t === "n" && v.trim() === ""))) return false;
      if (v === undefined) return true;
      if (t === "s") {
        const str = shared[Number(v)];
        return str !== undefined && str.trim() === "";
      }
      if (t === "e" || t === "b") return false;
      if (t === "str" || t === "d") return unescapeXml(v).trim() === "";
      return v.trim() === ""; // numeric: blank is decided on the raw text, exactly as cellValue does
    } catch {
      return false;
    }
  };

  const wanted = opts.columns ? new Set(opts.columns) : null;
  let mappedCols: Set<number> | null = null; // column positions to interpret; null = all (header row, or no `columns` given)
  const onRow = (rowXml: string) => {
    const cells: string[] = [];
    let sawUnmappedData = false;
    let cursor = -1;
    for (const { open, inner } of splitCells(rowXml, openTag(rowXml).length)) {
      const a = attrs(open);
      let col: number;
      if (a.r) {
        col = colIndex(a.r);
        if (col < 0 || col > 0x7fffff) throw new Error(`corrupt_workbook: malformed cell reference "${a.r}"`);
      } else col = cursor + 1; // no (or empty) reference: the next column along
      cursor = col;
      if (inner === undefined) continue;
      if (mappedCols && !mappedCols.has(col)) {
        // Not a column the caller reads: never interpreted, so it cannot fail anything. It still counts as
        // data for blank-row detection, so row numbers agree with the CSV reading of the same table.
        if (!blankCell(inner, a)) {
          if (col >= MAX_XLSX_COLUMNS) throw new Error(`too_many_columns: data beyond column ${MAX_XLSX_COLUMNS} (cell ${a.r ?? col + 1})`);
          sawUnmappedData = true;
        }
        continue;
      }
      const where = `cell ${a.r ?? `#${col + 1}`}`;
      let value: string;
      try {
        value = cellValue(inner, a, where);
      } catch (err) {
        if (!(err instanceof CellError)) throw err;
        value = CELL_ERROR_PREFIX + err.message;
      }
      if (value === "") continue;
      if (col >= MAX_XLSX_COLUMNS) throw new Error(`too_many_columns: data beyond column ${MAX_XLSX_COLUMNS} (cell ${a.r ?? col + 1})`);
      cells[col] = value;
    }
    const full = Array.from(cells, (c) => c ?? ""); // Array.from fills holes with undefined
    if (!sawUnmappedData && full.every((c) => c.trim() === "")) return; // a blank row is not a record, as a blank line is not in CSV
    if (headers === null) {
      const h = full.map((c) => c.trim());
      while (h.length > 0 && h[h.length - 1] === "") h.pop();
      const seen = new Set<string>();
      const dupes = new Set<string>();
      for (const name of h) {
        if (name === "") continue;
        if (seen.has(name)) dupes.add(name);
        seen.add(name);
      }
      if (dupes.size > 0) throw new Error(`duplicate_headers: ${[...dupes].join(", ")}`);
      headers = h;
      if (wanted) mappedCols = new Set(h.flatMap((name, i) => (wanted.has(name) ? [i] : [])));
      return;
    }
    if (rows.length >= opts.maxRows) {
      throw new Error(`too_many_rows: more than ${opts.maxRows} rows; split the file`);
    }
    rows.push(full);
  };

  const scan = new ElementScanner("row");
  streamText(bytes, sheetEntry, budget, (t) => scan.feed(t, onRow));

  if (headers === null) throw new Error("empty_file: the sheet has no header row");
  return { headers, rows };
}
