/** Thin fetch wrapper: same-origin cookies, CSRF header on writes, typed errors. */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) { super(message); }
}
let csrf: string | null = null;
export const setCsrf = (t: string | null) => { csrf = t; };
let onUnauthenticated: (() => void) | null = null;
export const setUnauthenticatedHandler = (fn: () => void) => { onUnauthenticated = fn; };

export async function api<T = any>(method: string, url: string, body?: unknown, opts: { headers?: Record<string, string>; raw?: BodyInit } = {}): Promise<T> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (method !== 'GET' && csrf) headers['x-csrf-token'] = csrf;
  let payload: BodyInit | undefined = opts.raw;
  if (body !== undefined && !opts.raw) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  let res: Response;
  try { res = await fetch('/api' + url, { method, headers, body: payload, credentials: 'same-origin' }); }
  catch { throw new ApiError(0, 'OFFLINE', 'Cannot reach the server. Check your connection — nothing was saved.'); }
  const ct = res.headers.get('content-type') ?? '';
  const data = ct.includes('application/json') ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    const e = data?.error;
    if (res.status === 401 && e?.code === 'UNAUTHENTICATED') onUnauthenticated?.();
    throw new ApiError(res.status, e?.code ?? 'ERROR', e?.message ?? `Request failed (${res.status})`, e?.details);
  }
  return data as T;
}
export const get = <T = any>(url: string) => api<T>('GET', url);
export const post = <T = any>(url: string, body?: unknown) => api<T>('POST', url, body ?? {});
export const patch = <T = any>(url: string, body?: unknown) => api<T>('PATCH', url, body ?? {});
export const put = <T = any>(url: string, body?: unknown) => api<T>('PUT', url, body ?? {});
export const del = <T = any>(url: string) => api<T>('DELETE', url);
