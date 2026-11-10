/** RFC-4180-style CSV reader with delimiter detection and legacy-encoding aware decoding. */
export function decodeBytes(bytes: Uint8Array): { text: string; encoding: string } {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8 (BOM)' };
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' };
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' };
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' }; }
  catch { return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' }; }
}
export function detectDelimiter(text: string): string {
  const head = text.split(/\r?\n/).slice(0, 10);
  let best = ',', bestScore = -1;
  for (const d of [',', ';', '\t', '|']) {
    const counts = head.filter(l => l.trim()).map(l => countOutsideQuotes(l, d));
    if (!counts.length || counts[0] === 0) continue;
    const consistent = counts.filter(c => c === counts[0]).length;
    const score = consistent * 1000 + counts[0];
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}
function countOutsideQuotes(line: string, d: string): number {
  let n = 0, q = false;
  for (const ch of line) { if (ch === '"') q = !q; else if (ch === d && !q) n++; }
  return n;
}
export function parseCsv(text: string, delimiter?: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const d = delimiter ?? detectDelimiter(text);
  const rows: string[][] = []; let row: string[] = [], field = '', q = false, i = 0, quoted = false;
  const pushField = () => { row.push(field); field = ''; quoted = false; };
  const pushRow = () => { pushField(); if (row.length > 1 || row[0] !== '') rows.push(row); row = []; };
  while (i < text.length) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } q = false; i++; continue; }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === '' && !quoted) { q = true; quoted = true; i++; continue; }
    if (ch === d) { pushField(); i++; continue; }
    if (ch === '\r') { if (text[i + 1] === '\n') i++; pushRow(); i++; continue; }
    if (ch === '\n') { pushRow(); i++; continue; }
    field += ch; i++;
  }
  if (field !== '' || row.length) pushRow();
  return rows;
}
export function toCsv(rows: (string | number | null | undefined)[][], delimiter = ','): string {
  const esc = (v: string | number | null | undefined) => { const s = v == null ? '' : String(v); return /["\r\n]/.test(s) || s.includes(delimiter) ? `"${s.replace(/"/g, '""')}"` : s; };
  return rows.map(r => r.map(esc).join(delimiter)).join('\r\n') + '\r\n';
}
