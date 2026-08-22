/**
 * Network access.
 *
 * The CDN throttles: fetching nine module URLs in a tight loop produced six
 * connection failures that all succeeded on retry. So every request here goes
 * through bounded retry with backoff, and bulk fetching is capped per host.
 * Without this, offline exports silently ship truncated files.
 */

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface FetchOptions {
  retries?: number;
  timeoutMs?: number;
  /** Base backoff in ms; doubles each attempt. */
  backoffMs?: number;
}

const DEFAULTS: Required<FetchOptions> = {
  retries: 3,
  timeoutMs: 30_000,
  backoffMs: 500,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fetch with timeout and exponential backoff. Throws after the last attempt. */
export async function fetchWithRetry(
  url: string,
  options: FetchOptions = {},
): Promise<Response> {
  const { retries, timeoutMs, backoffMs } = { ...DEFAULTS, ...options };
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
        redirect: 'follow',
        signal: controller.signal,
      });

      // 5xx and 429 are worth retrying; 4xx generally is not.
      if (res.status >= 500 || res.status === 429) {
        lastError = new Error(`HTTP ${res.status} for ${url}`);
        if (attempt < retries) {
          await sleep(backoffMs * 2 ** attempt);
          continue;
        }
      }
      return res;
    } catch (err) {
      lastError = err;
      if (attempt < retries) await sleep(backoffMs * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(
    `Failed to fetch ${url} after ${retries + 1} attempts: ${String(lastError)}`,
  );
}

/** Fetch a page as text, failing loudly on a non-OK status. */
export async function fetchPage(url: string): Promise<string> {
  const res = await fetchWithRetry(url);
  if (!res.ok) {
    throw new Error(`Could not fetch ${url} — server returned HTTP ${res.status}.`);
  }
  return res.text();
}

/**
 * Read a site's sitemap.xml. Framer publishes one on every site, which makes it
 * the cheapest reliable route source. Returns [] if there isn't one.
 */
export async function fetchSitemapRoutes(siteUrl: string): Promise<string[]> {
  const base = new URL(siteUrl);
  const sitemapUrl = new URL('/sitemap.xml', base).toString();

  try {
    const res = await fetchWithRetry(sitemapUrl, { retries: 1 });
    if (!res.ok) return [];
    const xml = await res.text();
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
    return [...new Set(locs)];
  } catch {
    return [];
  }
}
