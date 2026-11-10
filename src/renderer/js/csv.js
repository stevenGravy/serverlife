/**
 * RFC4180-ish CSV — a field containing a comma, quote or newline gets
 * wrapped in quotes with internal quotes doubled; everything else is
 * written bare. `columns`: `[{key, label}]`, `key` read from each row
 * (dotted paths not needed — the browser's own rows are already flat).
 */
function csvField(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows, columns) {
  const header = columns.map((c) => csvField(c.label ?? c.key)).join(',');
  const lines = (rows || []).map((row) => columns.map((c) => csvField(row[c.key])).join(','));
  return [header, ...lines].join('\r\n') + '\r\n';
}
