export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    credentials: 'same-origin',
    headers: {
      'X-Requested-With': 'mcs',
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('mcs:unauthorized'));
    throw new ApiError(data.message || data.error || `HTTP ${res.status}`, res.status, data.error);
  }
  return data as T;
}

export const post = <T = any>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body });
export const put = <T = any>(path: string, body: unknown = {}) => api<T>(path, { method: 'PUT', body });
export const patch = <T = any>(path: string, body: unknown = {}) => api<T>(path, { method: 'PATCH', body });
export const del = <T = any>(path: string) => api<T>(path, { method: 'DELETE', body: {} });

export function fmtTime(ms: number | null | undefined, lang: 'zh' | 'en') {
  if (!ms) return '';
  const d = new Date(ms);
  const nowD = new Date();
  const sameDay = d.toDateString() === nowD.toDateString();
  return d.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-MY', sameDay ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtDuration(ms: number, lang: 'zh' | 'en') {
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  return lang === 'zh' ? (h ? `${h} 小时 ${m} 分` : `${m} 分钟`) : h ? `${h}h ${m}m` : `${m}m`;
}

export interface Media {
  id: string;
  productId: string | null;
  kind: 'image' | 'video';
  title: string;
  mime: string;
  size: number;
  sortOrder: number;
  url: string;
  createdAt: number;
}

export async function uploadMedia(file: File, productId: string | null, title: string) {
  if (file.size > 25 * 1024 * 1024) throw new Error('档案太大，最多 25MB');
  const qs = new URLSearchParams({ title });
  if (productId) qs.set('productId', productId);
  const res = await fetch('/api/media?' + qs.toString(), {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'X-Requested-With': 'mcs', 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.message || data.error || `HTTP ${res.status}`, res.status, data.error);
  return data as { id: string; url: string };
}

export const fmtSize = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
