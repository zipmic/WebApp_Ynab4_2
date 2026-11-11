/**
 * Local OCR. The engine (Tesseract compiled to WebAssembly), its worker and the Danish/English
 * language data are all served from this app's own origin (/ocr/…), and recognition runs inside the
 * browser: screenshots never leave the device.
 */
import { wordsToLines, type OcrLine, type OcrWord } from '../../shared/bankparse';

let workerPromise: Promise<any> | null = null;
let progressCb: ((p: number) => void) | null = null;
async function getWorker() {
  workerPromise ??= (async () => {
    const { createWorker } = await import('tesseract.js');
    const w = await createWorker(['dan', 'eng'], 1, { workerPath: '/ocr/worker.min.js', corePath: '/ocr/core', langPath: '/ocr/lang', gzip: true, workerBlobURL: false,
      logger: (m: any) => { if (m.status === 'recognizing text') progressCb?.(m.progress); } });
    await w.setParameters({ tessedit_pageseg_mode: '6' as any, preserve_interword_spaces: '1' });
    return w;
  })();
  workerPromise.catch(() => { workerPromise = null; });
  return workerPromise;
}
/** Upscale small screenshots and turn dark-mode screenshots into dark-on-light, which OCR reads far better. */
async function prepare(blob: Blob): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(3, Math.max(1, 1600 / bmp.width)), w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  if (w * h > 40_000_000) throw new Error('Image is too large');
  const c = document.createElement('canvas'); c.width = w; c.height = h; const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high'; ctx.drawImage(bmp, 0, 0, w, h); bmp.close();
  const img = ctx.getImageData(0, 0, w, h), d = img.data; let sum = 0;
  for (let i = 0; i < d.length; i += 4) { const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000; d[i] = d[i + 1] = d[i + 2] = g; sum += g; }
  if (sum / (d.length / 4) < 115) for (let i = 0; i < d.length; i += 4) { d[i] = d[i + 1] = d[i + 2] = 255 - d[i]; }
  ctx.putImageData(img, 0, 0);
  return c;
}
export async function ocrImage(blob: Blob, onProgress?: (p: number) => void): Promise<OcrLine[]> {
  const canvas = await prepare(blob); const worker = await getWorker();
  progressCb = onProgress ?? null;
  try {
    const { data } = await worker.recognize(canvas, {}, { blocks: true });
    const words: OcrWord[] = [];
    for (const b of data.blocks ?? []) for (const p of b.paragraphs ?? []) for (const l of p.lines ?? []) for (const w of l.words ?? []) words.push({ text: w.text, confidence: w.confidence, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 });
    return wordsToLines(words);
  } finally { progressCb = null; canvas.width = canvas.height = 0; }
}
export async function sniffImage(blob: Blob): Promise<boolean> {
  const b = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  return (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) || (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) || (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45);
}
