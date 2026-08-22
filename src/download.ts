/**
 * Offline asset downloading.
 *
 * This is the tier that makes an export genuinely portable — no dependency on
 * framerusercontent staying up or staying free. Three things make it harder
 * than it looks:
 *
 *   - The CDN throttles. Nine parallel requests produced six connection
 *     failures that all succeeded on retry, so everything is bounded and
 *     retried rather than fired off with Promise.all.
 *
 *   - Responsive images differ only by query string. `image.png?scale-down-to=512`
 *     and `image.png?scale-down-to=2048` are different files with the same
 *     basename, so local names are hashed over the FULL url including the query.
 *
 *   - A failed download must not produce a broken page. Anything we cannot
 *     fetch keeps its original absolute URL and is reported, because a
 *     hotlinked image beats a missing one.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, extname, basename } from 'node:path';
import { fetchWithRetry } from './fetch.js';
import { mapWithConcurrency, DEFAULT_CONCURRENCY } from './pool.js';
import type { AssetRef } from './types.js';

/** Subdirectory per asset kind, keeps the output legible. */
const KIND_DIR: Record<AssetRef['kind'], string> = {
  image: 'assets/images',
  font: 'assets/fonts',
  video: 'assets/media',
  script: 'assets/runtime',
  other: 'assets/files',
};

/** Fallback extensions when the URL has none, keyed by response content-type. */
const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/x-icon': '.ico',
  'font/woff2': '.woff2',
  'font/woff': '.woff',
  'font/ttf': '.ttf',
  'font/otf': '.otf',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'text/css': '.css',
};

export interface DownloadedAsset {
  url: string;
  /** Output-root-relative path, e.g. "assets/images/hero-a1b2c3d4.png". */
  localPath: string;
  bytes: number;
  kind: AssetRef['kind'];
}

export interface DownloadResult {
  /** Original URL -> output-root-relative local path. */
  map: Map<string, string>;
  downloaded: DownloadedAsset[];
  failed: Array<{ url: string; reason: string }>;
  totalBytes: number;
  warnings: string[];
}

/** Short, stable hash of the full URL — distinguishes ?scale-down-to variants. */
function urlHash(url: string): string {
  return createHash('sha1').update(url).digest('hex').slice(0, 8);
}

/**
 * Derive a readable, collision-free local filename.
 * Keeps the original stem so the output stays debuggable.
 */
export function localNameFor(url: string, kind: AssetRef['kind'], contentType?: string): string {
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    /* keep raw string for relative inputs */
  }

  const rawBase = basename(pathname) || 'asset';

  // Runtime modules keep their exact filename. They import each other by
  // relative path — `./rolldown-runtime.DhnBybyj.mjs` — so appending our own
  // hash silently breaks every one of those imports and the page never
  // hydrates. Framer already content-hashes these names, so they are unique.
  if (kind === 'script') return `${KIND_DIR[kind]}/${rawBase}`;
  let ext = extname(rawBase);
  let stem = ext ? rawBase.slice(0, -ext.length) : rawBase;

  if (!ext && contentType) {
    ext = MIME_EXT[contentType.split(';')[0].trim().toLowerCase()] ?? '';
  }
  if (!ext) ext = '.bin';

  // Keep names filesystem-safe and bounded.
  stem = stem.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 48) || 'asset';

  return `${KIND_DIR[kind]}/${stem}-${urlHash(url)}${ext}`;
}

/** A URL we can actually fetch and store. */
function isDownloadable(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

export interface DownloadOptions {
  concurrency?: number;
  /** Skip anything larger than this, to keep a runaway video out of the ZIP. */
  maxBytes?: number;
  onProgress?: (done: number, total: number, url: string, ok: boolean) => void;
}

/**
 * Download every asset once and return the URL -> local path map.
 *
 * Assets are deduplicated by URL before fetching, so a logo referenced on forty
 * pages is retrieved a single time.
 */
export async function downloadAssets(
  assets: readonly AssetRef[],
  outDir: string,
  options: DownloadOptions = {},
): Promise<DownloadResult> {
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;

  const map = new Map<string, string>();
  const downloaded: DownloadedAsset[] = [];
  const failed: Array<{ url: string; reason: string }> = [];
  const warnings: string[] = [];

  // Deduplicate by URL, and drop anything not fetchable over http(s).
  const unique = new Map<string, AssetRef>();
  for (const a of assets) {
    if (!isDownloadable(a.url)) continue;
    if (!unique.has(a.url)) unique.set(a.url, a);
  }
  const list = [...unique.values()];

  let done = 0;
  const results = await mapWithConcurrency(
    list,
    async (asset) => {
      const res = await fetchWithRetry(asset.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const buf = Buffer.from(await res.arrayBuffer());

      // Integrity: a zero-byte body is a silent failure, not a valid asset.
      if (buf.byteLength === 0) throw new Error('empty response body');
      if (buf.byteLength > maxBytes) {
        throw new Error(`exceeds size cap (${buf.byteLength} bytes)`);
      }

      const contentType = res.headers.get('content-type') ?? undefined;
      const localPath = localNameFor(asset.url, asset.kind, contentType);
      const target = join(outDir, localPath);

      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, buf);

      return { url: asset.url, localPath, bytes: buf.byteLength, kind: asset.kind };
    },
    concurrency,
  );

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const url = list[i].url;
    done++;

    if (r.value) {
      map.set(url, r.value.localPath);
      downloaded.push(r.value);
      options.onProgress?.(done, list.length, url, true);
    } else {
      const reason = r.error instanceof Error ? r.error.message : String(r.error);
      failed.push({ url, reason });
      options.onProgress?.(done, list.length, url, false);
    }
  }

  if (failed.length > 0) {
    const sample = failed.slice(0, 3).map((f) => `${f.url} (${f.reason})`).join('; ');
    warnings.push(
      `${failed.length} asset(s) could not be downloaded and still point at the original CDN: ${sample}${
        failed.length > 3 ? ' …' : ''
      }`,
    );
  }

  return {
    map,
    downloaded,
    failed,
    totalBytes: downloaded.reduce((a, d) => a + d.bytes, 0),
    warnings,
  };
}
