/**
 * Minimal RFC 4180 parser (quoted fields, escaped quotes, embedded newlines, CRLF, BOM). Pure, so
 * the import action's IO stays separate from the part that can be tested without a deployment.
 * Failures are named errors (`empty_file`, `duplicate_headers`, `unterminated_quote`), never a
 * silently truncated dataset.
 */
export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  let wasQuoted = false;

  const endField = () => {
    record.push(field);
    field = "";
    wasQuoted = false;
  };
  const endRecord = () => {
    endField();
    // A line with a single empty, unquoted cell is a blank line, not a record.
    if (!(record.length === 1 && record[0]!.trim() === "")) records.push(record);
    record = [];
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === "" && !wasQuoted) {
      quoted = true;
      wasQuoted = true;
    } else if (ch === ",") endField();
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      endRecord();
    } else field += ch;
  }
  if (quoted) throw new Error("unterminated_quote: a quoted field is never closed");
  if (field !== "" || record.length > 0 || wasQuoted) endRecord();

  const [headerRow, ...rows] = records;
  if (!headerRow) throw new Error("empty_file: the file has no header row");
  const headers = headerRow.map((h) => h.trim());
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const h of headers) {
    if (h === "") continue; // a trailing comma leaves an unnamed column; it can't be mapped, so it can't collide
    if (seen.has(h)) dupes.add(h);
    seen.add(h);
  }
  if (dupes.size > 0) throw new Error(`duplicate_headers: ${[...dupes].join(", ")}`);
  return { headers, rows };
}
