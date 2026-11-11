import { unzipSync } from 'fflate';
import { decodeBytes } from '../../shared/csv';

export interface TextFile { path: string; text: string; encoding: string }
const RELEVANT = /\.(yfull|ydiff|ydevice|ymeta|csv|tsv|txt)$/i;

async function fromFile(f: File, path: string, out: TextFile[]) {
  if (/\.zip$/i.test(path)) {
    const entries = unzipSync(new Uint8Array(await f.arrayBuffer()), { filter: e => RELEVANT.test(e.name) && e.originalSize < 400 * 1024 * 1024 });
    for (const [name, bytes] of Object.entries(entries)) { if (name.endsWith('/') || name.includes('__MACOSX')) continue; const d = decodeBytes(bytes); out.push({ path: name, text: d.text, encoding: d.encoding }); }
  } else if (RELEVANT.test(path)) { const d = decodeBytes(new Uint8Array(await f.arrayBuffer())); out.push({ path, text: d.text, encoding: d.encoding }); }
}
export async function readFileList(list: FileList | File[]): Promise<TextFile[]> {
  const out: TextFile[] = [];
  for (const f of Array.from(list)) await fromFile(f, (f as any).webkitRelativePath || f.name, out);
  return out;
}
/** Reads dropped files AND folders (a .ynab4 budget is a folder). */
export async function readDrop(dt: DataTransfer): Promise<TextFile[]> {
  const out: TextFile[] = []; const entries = Array.from(dt.items).map(i => (i as any).webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return readFileList(dt.files);
  const walk = async (entry: any, prefix: string): Promise<void> => {
    if (entry.isFile) { const f: File = await new Promise((res, rej) => entry.file(res, rej)); await fromFile(f, prefix + entry.name, out); }
    else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) { const batch: any[] = await new Promise((res, rej) => reader.readEntries(res, rej)); if (!batch.length) break; for (const e of batch) await walk(e, prefix + entry.name + '/'); }
    }
  };
  for (const e of entries) await walk(e, '');
  return out;
}
