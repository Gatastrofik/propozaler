import type { HttpClient, HttpRequestLog } from "./types.js";

export class HttpError extends Error {
  constructor(readonly status: number, readonly url: string, readonly bodySnippet: string) {
    super(`HTTP ${status} for ${url}: ${bodySnippet}`);
    this.name = "HttpError";
  }
}

export interface HttpClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  minIntervalMs?: number;
  maxRetries?: number;
  retryOn429?: boolean;
  sleep?: (ms: number) => Promise<void>;
  redactParams?: string[];
  defaultHeaders?: Record<string, string>;
}

export function redactUrl(url: string, params: string[]): string {
  const u = new URL(url);
  for (const p of params) if (u.searchParams.has(p)) u.searchParams.set(p, "REDACTED");
  return u.toString();
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createHttpClient(opts: HttpClientOptions = {}): HttpClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const minIntervalMs = opts.minIntervalMs ?? 250;
  const maxRetries = opts.maxRetries ?? 2;
  const retryOn429 = opts.retryOn429 ?? false;
  const sleep = opts.sleep ?? defaultSleep;
  const redactParams = opts.redactParams ?? ["api_key", "$$app_token"];
  const log: HttpRequestLog[] = [];
  let lastAt = 0;

  async function once(url: string, headers: Record<string, string>): Promise<Response> {
    const wait = lastAt + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastAt = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { headers, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    log,
    async getJson<T>(url: string, init: { headers?: Record<string, string> } = {}): Promise<T> {
      const headers = { accept: "application/json", ...(opts.defaultHeaders ?? {}), ...(init.headers ?? {}) };
      const safeUrl = redactUrl(url, redactParams);
      let attempt = 0;
      for (;;) {
        const started = Date.now();
        try {
          const res = await once(url, headers);
          const ms = Date.now() - started;
          log.push({ method: "GET", url: safeUrl, status: res.status, ms });
          if (res.ok) return (await res.json()) as T;
          const snippet = (await res.text()).slice(0, 200);
          const retryable = res.status >= 500 || (res.status === 429 && retryOn429);
          if (retryable && attempt < maxRetries) {
            attempt += 1;
            await sleep(500 * 2 ** attempt);
            continue;
          }
          throw new HttpError(res.status, safeUrl, snippet);
        } catch (err) {
          if (err instanceof HttpError) throw err;
          const ms = Date.now() - started;
          const message = err instanceof Error ? err.message : String(err);
          log.push({ method: "GET", url: safeUrl, status: null, ms, error: message });
          if (attempt < maxRetries) {
            attempt += 1;
            await sleep(500 * 2 ** attempt);
            continue;
          }
          throw new Error(`request failed for ${safeUrl}: ${message}`);
        }
      }
    },
  };
}
