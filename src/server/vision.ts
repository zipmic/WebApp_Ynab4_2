/**
 * Optional, opt-in vision extraction for difficult screenshots. Talks to any OpenAI-compatible
 * chat-completions endpoint (a hosted provider, or a self-hosted server such as Ollama / LM Studio).
 * The API key lives only in server configuration; images are held in memory, sent once, and never
 * written to disk or logged. The provider's answer is validated against the strict import schema.
 */
import type { Config } from './config.ts';
import { AppError } from './errors.ts';
import { IMPORT_SCHEMA_ID, parseImportJson, type Candidate } from '../shared/bankparse.ts';

export function sniffImage(buf: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}
const PROMPT = `You read a screenshot of a bank's transaction list. Return ONLY a JSON object, no prose, in exactly this shape:
{"schema":"${IMPORT_SCHEMA_ID}","transactions":[{"date":"YYYY-MM-DD","payee":"text as shown","amount":"-123.45"}]}
Rules: one entry per fully visible transaction row, in the order shown. amount is a decimal string with a dot; NEGATIVE for money leaving the account, positive for money coming in.
Do not include running balances. If the year is not shown assume {YEAR}. Never guess: skip any row whose date or amount is cut off or unreadable. Do not add rows that are not in the image.`;

export async function extractWithVision(cfg: Config, image: Buffer, sourceIndex: number, today: string, fetchImpl: typeof fetch = fetch): Promise<Candidate[]> {
  if (!cfg.vision) throw new AppError(400, 'VISION_NOT_CONFIGURED', 'No vision provider is configured on the server.');
  const mime = sniffImage(image); if (!mime) throw new AppError(415, 'UNSUPPORTED_IMAGE', 'Only PNG, JPEG and WebP images are accepted.');
  let res: Response;
  try {
    res = await fetchImpl(cfg.vision.baseUrl + '/chat/completions', {
      method: 'POST', signal: AbortSignal.timeout(90_000),
      headers: { 'content-type': 'application/json', ...(cfg.vision.apiKey ? { authorization: `Bearer ${cfg.vision.apiKey}` } : {}) },
      body: JSON.stringify({ model: cfg.vision.model, temperature: 0, response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT.replace('{YEAR}', today.slice(0, 4)) }, { type: 'image_url', image_url: { url: `data:${mime};base64,${image.toString('base64')}` } }] }] }),
    });
  } catch { throw new AppError(502, 'VISION_UNREACHABLE', 'The vision provider could not be reached.'); }
  if (!res.ok) throw new AppError(502, 'VISION_ERROR', `The vision provider answered with HTTP ${res.status}.`);
  const body = await res.json().catch(() => null) as any;
  let text: unknown = body?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') throw new AppError(502, 'VISION_BAD_RESPONSE', 'The vision provider returned no usable answer.');
  text = (text as string).trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  const parsed = parseImportJson(text as string, { sourceIndex, today });
  if (parsed.errors.length) throw new AppError(502, 'VISION_INVALID_DATA', 'The vision provider returned data that failed validation: ' + parsed.errors.slice(0, 3).join('; '));
  for (const c of parsed.candidates) { c.issues.push('ai_extracted'); c.confidence = Math.min(c.confidence, 0.7); }
  return parsed.candidates;
}
