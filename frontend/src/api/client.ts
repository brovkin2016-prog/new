const BASE = (import.meta as any).env?.VITE_API_URL ?? 'http://localhost:3000/api';

export function getToken(): string | null {
  return localStorage.getItem('pf_token');
}
export function setToken(t: string | null) {
  if (t) localStorage.setItem('pf_token', t);
  else localStorage.removeItem('pf_token');
}

async function req<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {}),
    },
  });
  if (res.status === 401) {
    setToken(null);
    location.hash = '#/login';
    throw new Error('Требуется авторизация');
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message ?? `Ошибка ${res.status}`);
  return res.status === 204 ? (undefined as T) : res.json();
}

export const api = {
  get: <T>(p: string) => req<T>(p),
  post: <T>(p: string, body?: unknown) => req<T>(p, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  patch: <T>(p: string, body?: unknown) => req<T>(p, { method: 'PATCH', body: JSON.stringify(body ?? {}) }),
  del: <T>(p: string) => req<T>(p, { method: 'DELETE' }),
  exportUrl: (runId: string, format: 'csv' | 'xlsx') =>
    `${BASE}/runs/${runId}/report/export?format=${format}`,
  async download(runId: string, format: 'csv' | 'xlsx') {
    const res = await fetch(`${BASE}/runs/${runId}/report/export?format=${format}`, {
      headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {},
    });
    if (!res.ok) throw new Error('Не удалось экспортировать');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `report-${runId}.${format}`;
    a.click();
    URL.revokeObjectURL(url);
  },
};
