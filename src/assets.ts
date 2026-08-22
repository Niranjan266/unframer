/**
 * Asset handling.
 *
 * Phase 01 ships `hotlink` mode: assets keep pointing at framerusercontent,
 * which measurably works (the CDN serves 200 with and without a Referer). We
 * still walk and inventory every reference, because that inventory is exactly
 * what offline mode will consume in phase 03 — and because a count of assets is
 * something the user should see in the report.
 */

import type { CheerioAPI } from 'cheerio';
import type { AssetRef } from './types.js';

/**
 * Meta tags whose `content` is an image URL. Social crawlers require these to
 * be absolute, so they are localised differently from ordinary assets.
 */
export const META_IMAGE_SELECTOR =
  'meta[property="og:image"], meta[property="og:image:secure_url"], meta[name="twitter:image"], meta[property="twitter:image"]';

const FONT_RE = /\.(woff2?|ttf|otf|eot)(\?|$)/i;
const VIDEO_RE = /\.(mp4|webm|mov|m4v)(\?|$)/i;
const IMAGE_RE = /\.(png|jpe?g|gif|svg|webp|avif)(\?|$)/i;
const SCRIPT_RE = /\.mjs(\?|$)/i;

function classify(url: string): AssetRef['kind'] {
  if (SCRIPT_RE.test(url)) return 'script';
  if (FONT_RE.test(url)) return 'font';
  if (VIDEO_RE.test(url)) return 'video';
  if (IMAGE_RE.test(url)) return 'image';
  if (url.includes('framerusercontent.com/images/')) return 'image';
  return 'other';
}

/** Split a `srcset` value into its URLs, discarding descriptors. */
export function parseSrcset(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean);
}

/** Pull every `url(...)` target out of a CSS string. */
export function extractCssUrls(css: string): string[] {
  const out: string[] = [];
  const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    const u = m[2].trim();
    if (u && !u.startsWith('data:')) out.push(u);
  }
  return out;
}

/**
 * Inventory every asset the document references: img src/srcset, source
 * srcset, video, link href, and url() inside inline styles and stylesheets.
 */
export function inventoryAssets($: CheerioAPI, includeRuntime = false): AssetRef[] {
  const seen = new Set<string>();
  const assets: AssetRef[] = [];

  const add = (raw: string | undefined) => {
    if (!raw) return;
    const url = raw.trim();
    if (!url || url.startsWith('data:') || url.startsWith('#')) return;
    if (seen.has(url)) return;
    seen.add(url);
    assets.push({ url, kind: classify(url) });
  };

  $('img[src]').each((_, el) => add($(el).attr('src')));
  $('img[srcset], source[srcset]').each((_, el) => {
    const ss = $(el).attr('srcset');
    if (ss) parseSrcset(ss).forEach(add);
  });
  $('video[src], source[src], audio[src]').each((_, el) => add($(el).attr('src')));
  $('video[poster]').each((_, el) => add($(el).attr('poster')));
  $('link[rel="icon"], link[rel="apple-touch-icon"], link[rel="stylesheet"]').each((_, el) =>
    add($(el).attr('href')),
  );

  // Social preview images. Easy to miss because they live in meta content
  // rather than a src, and leaving them behind means the export still phones
  // home every time a link to it is shared.
  $(META_IMAGE_SELECTOR).each((_, el) => add($(el).attr('content')));

  // Framer's runtime modules, only when we are keeping them. They import each
  // other by relative path, so downloading the set into one directory is enough
  // for hydration to work offline.
  if (includeRuntime) {
    $('script[src]').each((_, el) => {
      const src = $(el).attr('src');
      if (src && SCRIPT_RE.test(src)) add(src);
    });
    $('link[rel="modulepreload"][href]').each((_, el) => add($(el).attr('href')));
  }

  $('style').each((_, el) => {
    const css = $(el).html() ?? '';
    extractCssUrls(css).forEach(add);
  });

  $('[style]').each((_, el) => {
    const style = $(el).attr('style') ?? '';
    if (style.includes('url(')) extractCssUrls(style).forEach(add);
  });

  return assets;
}

/**
 * Normalise protocol-relative URLs to https so the export works when opened
 * from the filesystem, where `//host/path` resolves to `file://host/path`.
 */
export function normalizeProtocolRelative($: CheerioAPI): number {
  let fixed = 0;

  const fixAttr = (sel: string, attr: string) => {
    $(sel).each((_, el) => {
      const v = $(el).attr(attr);
      if (v && v.startsWith('//')) {
        $(el).attr(attr, `https:${v}`);
        fixed++;
      }
    });
  };

  fixAttr('img[src], script[src], video[src], source[src]', 'src');
  fixAttr('link[href], a[href]', 'href');

  $('img[srcset], source[srcset]').each((_, el) => {
    const ss = $(el).attr('srcset');
    if (ss && ss.includes('//') && /(^|,)\s*\/\//.test(ss)) {
      $(el).attr(
        'srcset',
        ss.replace(/(^|,\s*)\/\//g, (_m, p1) => `${p1}https://`),
      );
      fixed++;
    }
  });

  return fixed;
}
