import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';

/** Запрос с ретраями и экспоненциальной задержкой на сетевые/5xx ошибки. */
export async function requestWithRetry<T = any>(
  config: AxiosRequestConfig,
  retries = 4,
  baseDelayMs = 500,
): Promise<AxiosResponse<T>> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await axios.request<T>({ timeout: 20000, ...config });
    } catch (err: any) {
      lastErr = err;
      const status = err?.response?.status;
      // не ретраим клиентские ошибки, кроме 429
      if (status && status < 500 && status !== 429) throw err;
      if (attempt === retries) break;
      const delay = baseDelayMs * 2 ** attempt;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
