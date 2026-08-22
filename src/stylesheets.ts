/**
 * Stylesheet localisation.
 *
 * Framer inlines all of its CSS, so the Framer path never needed this. Ordinary
 * sites do not: they link external stylesheets, and those stylesheets reference
 * their own images and fonts through `url(...)`. Downloading the CSS file alone
 * leaves every one of those pointing back at the original host, so backgrounds
 * and webfonts silently keep loading from a server the export is supposed to be
 * independent of.
 *
 * So this runs a second pass over the CSS that has landed on disk: resolve each
 * `url(...)` against the stylesheet's ORIGINAL address — not the page's, since
 * a stylesheet at `/css/app.css` resolves `../img/x.png` relative to itself —
 * download what it finds, and rewrite the file to relative local paths.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname, relative, resolve } from 'node:path';
import { downloadAssets, type DownloadResult } from './download.js';
import type { AssetRef } from './types.js';

/** `url(...)` targets, ignoring data URIs. */
const URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

/** `@import "..."` targets, which pull in yet more stylesheets. */
const IMPORT_RE = /@import\s+(?:url\()?\s*(['"])([^'"]+)\1\s*\)?/g;

function classify(url: string): AssetRef['kind'] {
  if (/\.(woff2?|ttf|otf|eot)(\?|$)/i.test(url)) return 'font';
  if (/\.(png|jpe?g|gif|svg|webp|avif|ico)(\?|$)/i.test(url)) return 'image';
  if (/\.(mp4|webm|mov)(\?|$)/i.test(url)) return 'video';
  if (/\.css(\?|$)/i.test(url)) return 'style';
  return 'other';
}

export interface StylesheetResult {
  /** Stylesheets rewritten. */
  filesRewritten: number;
  /** Assets discovered inside CSS and downloaded. */
  assetsFound: number;
  references: number;
  warnings: string[];
}

/**
 * Fetch and rewrite everything referenced from downloaded stylesheets.
 *
 * @param outDir   export root
 * @param download result of the first download pass, mutated with new entries
 */
export async function localizeStylesheets(
  outDir: string,
  download: DownloadResult,
  concurrency = 4,
): Promise<StylesheetResult> {
  const root = resolve(outDir);
  const warnings: string[] = [];

  const sheets = download.downloaded.filter((d) => d.kind === 'style');
  if (sheets.length === 0) {
    return { filesRewritten: 0, assetsFound: 0, references: 0, warnings };
  }

  // Discover every referenced URL, resolved against its own stylesheet.
  const discovered = new Map<string, AssetRef>();
  const perSheet = new Map<string, string[]>();
  let references = 0;

  for (const sheet of sheets) {
    let css: string;
    try {
      css = await readFile(join(root, sheet.localPath), 'utf8');
    } catch {
      warnings.push(`Could not read stylesheet ${sheet.localPath}`);
      continue;
    }

    const found: string[] = [];
    for (const re of [URL_RE, IMPORT_RE]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(css)) !== null) {
        const raw = m[2].trim();
        if (!raw || raw.startsWith('data:') || raw.startsWith('#')) continue;

        let absolute: string;
        try {
          absolute = new URL(raw, sheet.url).toString();
        } catch {
          continue;
        }
        if (!/^https?:/i.test(absolute)) continue;

        references++;
        found.push(absolute);
        if (!discovered.has(absolute)) {
          discovered.set(absolute, { url: absolute, kind: classify(absolute) });
        }
      }
    }
    perSheet.set(sheet.localPath, found);
  }

  if (discovered.size === 0) {
    return { filesRewritten: 0, assetsFound: 0, references, warnings };
  }

  // Skip anything the page already pulled down.
  const pending = [...discovered.values()].filter((a) => !download.map.has(a.url));
  const extra = await downloadAssets(pending, root, { concurrency });

  for (const [url, local] of extra.map) download.map.set(url, local);
  download.downloaded.push(...extra.downloaded);
  download.failed.push(...extra.failed);
  warnings.push(...extra.warnings);

  // Rewrite each stylesheet to point at the local copies, relative to where the
  // stylesheet itself now lives.
  let filesRewritten = 0;

  for (const sheet of sheets) {
    const refs = perSheet.get(sheet.localPath);
    if (!refs || refs.length === 0) continue;

    const file = join(root, sheet.localPath);
    let css: string;
    try {
      css = await readFile(file, 'utf8');
    } catch {
      continue;
    }

    const fromDir = dirname(join(root, sheet.localPath));
    const rewrite = (raw: string): string | null => {
      let absolute: string;
      try {
        absolute = new URL(raw, sheet.url).toString();
      } catch {
        return null;
      }
      const local = download.map.get(absolute);
      if (!local) return null;
      // Forward slashes: this is a URL, not a filesystem path.
      return relative(fromDir, join(root, local)).split('\\').join('/');
    };

    let changed = false;
    css = css.replace(URL_RE, (whole, quote: string, raw: string) => {
      if (raw.startsWith('data:')) return whole;
      const next = rewrite(raw);
      if (!next) return whole;
      changed = true;
      return `url(${quote}${next}${quote})`;
    });
    css = css.replace(IMPORT_RE, (whole, quote: string, raw: string) => {
      const next = rewrite(raw);
      if (!next) return whole;
      changed = true;
      return `@import ${quote}${next}${quote}`;
    });

    if (changed) {
      await writeFile(file, css, 'utf8');
      filesRewritten++;
    }
  }

  return {
    filesRewritten,
    assetsFound: extra.downloaded.length,
    references,
    warnings,
  };
}
