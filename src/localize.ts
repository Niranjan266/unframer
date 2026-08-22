/**
 * Asset localisation.
 *
 * Rewrites every asset reference in a document from its CDN URL to the
 * downloaded local copy. Two details carry most of the risk:
 *
 *   - `srcset` must be rewritten in full. Framer ships several `?scale-down-to=`
 *     variants per image; rewriting only `src` leaves the browser fetching the
 *     rest from the CDN, which quietly defeats the whole point of an offline
 *     package.
 *
 *   - Paths are relative to the *page*, not the site root. A page at
 *     `/blog/post` lives in `blog/post/index.html`, so it reaches a shared asset
 *     via `../../assets/…`. Root-relative paths would break both `file://` use
 *     and subdirectory hosting.
 *
 * Anything absent from the map keeps its original URL. That is deliberate: a
 * hotlinked asset still renders, a rewritten-but-missing one does not.
 */

import type { CheerioAPI } from 'cheerio';
import { relativePrefix } from './links.js';
import { META_IMAGE_SELECTOR } from './assets.js';

export interface LocalizeResult {
  rewritten: number;
  /** References left pointing at the original CDN because no local copy exists. */
  leftRemote: number;
}

/** Rewrite a single URL if we have a local copy of it. */
function localFor(
  url: string,
  map: ReadonlyMap<string, string>,
  prefix: string,
  baseUrl?: string,
): string | null {
  const value = url.trim();
  let local = map.get(value);

  // The map is keyed by absolute URL, but the document may reference the same
  // asset by relative path, so resolve before giving up.
  if (!local && baseUrl && !/^https?:\/\//i.test(value)) {
    try {
      local = map.get(new URL(value, baseUrl).toString());
    } catch {
      /* not resolvable */
    }
  }

  return local ? `${prefix}${local}` : null;
}

/**
 * Repoint every asset reference in the document at its local copy.
 *
 * @param currentRoute Route of the page being rewritten, used to compute depth.
 */
export function localizeAssets(
  $: CheerioAPI,
  map: ReadonlyMap<string, string>,
  currentRoute: string,
  baseUrl?: string,
): LocalizeResult {
  const prefix = relativePrefix(currentRoute);
  const result: LocalizeResult = { rewritten: 0, leftRemote: 0 };

  const rewriteAttr = (selector: string, attr: string) => {
    $(selector).each((_, el) => {
      const value = $(el).attr(attr);
      if (!value || value.startsWith('data:')) return;
      const local = localFor(value, map, prefix, baseUrl);
      if (local) {
        $(el).attr(attr, local);
        result.rewritten++;
      } else if (/^https?:\/\//i.test(value)) {
        result.leftRemote++;
      }
    });
  };

  rewriteAttr('img[src], video[src], audio[src], source[src], script[src]', 'src');
  rewriteAttr('video[poster]', 'poster');
  rewriteAttr(
    'link[rel="icon"], link[rel="apple-touch-icon"], link[rel="stylesheet"], link[rel="preload"], link[rel="modulepreload"]',
    'href',
  );

  // srcset: rewrite every candidate, preserving its descriptor.
  $('img[srcset], source[srcset]').each((_, el) => {
    const srcset = $(el).attr('srcset');
    if (!srcset) return;

    let changed = false;
    const rebuilt = srcset
      .split(',')
      .map((candidate) => {
        const trimmed = candidate.trim();
        if (!trimmed) return null;
        const parts = trimmed.split(/\s+/);
        const url = parts[0];
        const descriptor = parts.slice(1).join(' ');
        const local = localFor(url, map, prefix, baseUrl);
        if (local) {
          changed = true;
          result.rewritten++;
          return descriptor ? `${local} ${descriptor}` : local;
        }
        if (/^https?:\/\//i.test(url)) result.leftRemote++;
        return trimmed;
      })
      .filter((c): c is string => c !== null);

    if (changed) $(el).attr('srcset', rebuilt.join(', '));
  });

  // CSS url() inside <style> blocks — this is where @font-face lives.
  $('style').each((_, el) => {
    const css = $(el).html();
    if (!css || !css.includes('url(')) return;
    const next = rewriteCssUrls(css, map, prefix, result, baseUrl);
    if (next !== css) $(el).html(next);
  });

  // CSS url() inside inline style attributes.
  $('[style]').each((_, el) => {
    const style = $(el).attr('style');
    if (!style || !style.includes('url(')) return;
    const next = rewriteCssUrls(style, map, prefix, result, baseUrl);
    if (next !== style) $(el).attr('style', next);
  });

  return result;
}

/**
 * Rewrite `url(...)` targets inside a CSS string.
 * Quoting style is preserved so the output diffs cleanly against the original.
 */
export function rewriteCssUrls(
  css: string,
  map: ReadonlyMap<string, string>,
  prefix: string,
  result?: LocalizeResult,
  baseUrl?: string,
): string {
  return css.replace(
    /url\(\s*(['"]?)([^'")]+)\1\s*\)/g,
    (whole, quote: string, url: string) => {
      if (url.startsWith('data:')) return whole;
      const local = localFor(url, map, prefix, baseUrl);
      if (local) {
        if (result) result.rewritten++;
        return `url(${quote}${local}${quote})`;
      }
      if (result && /^https?:\/\//i.test(url)) result.leftRemote++;
      return whole;
    },
  );
}

/**
 * Localise social preview images (`og:image`, `twitter:image`).
 *
 * These cannot use the relative paths everything else gets: Facebook, X and
 * every other crawler resolve them from outside the page and require an
 * absolute URL. So they are only rewritten when we know the final domain —
 * otherwise the CDN URL is left in place, because a working preview pointing at
 * Framer beats a broken relative path that no crawler can resolve.
 *
 * @returns the number rewritten, and whether any were left remote for want of a base URL.
 */
export function localizeMetaImages(
  $: CheerioAPI,
  map: ReadonlyMap<string, string>,
  baseUrl?: string,
): { rewritten: number; needsBaseUrl: number } {
  let rewritten = 0;
  let needsBaseUrl = 0;

  $(META_IMAGE_SELECTOR).each((_, el) => {
    const content = $(el).attr('content');
    if (!content) return;

    const local = map.get(content.trim());
    if (!local) return;

    if (!baseUrl) {
      needsBaseUrl++;
      return;
    }

    $(el).attr('content', `${baseUrl.replace(/\/$/, '')}/${local}`);
    rewritten++;
  });

  return { rewritten, needsBaseUrl };
}

/**
 * Google Fonts stylesheets are referenced by `<link>` rather than inlined, so
 * their @font-face rules live in a file we would also have to fetch and rewrite.
 * Framer normally inlines its font CSS, but a custom-code slot can add a link.
 * Detect it and say so rather than silently shipping a page that phones home.
 */
export function auditRemoteStylesheets($: CheerioAPI): string[] {
  const warnings: string[] = [];
  const remote: string[] = [];

  $('link[rel="stylesheet"][href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    if (/^https?:\/\//i.test(href)) remote.push(href);
  });

  if (remote.length > 0) {
    warnings.push(
      `${remote.length} stylesheet(s) still load from a remote host, so the page is not fully self-contained: ${remote
        .slice(0, 3)
        .join(', ')}${remote.length > 3 ? ' …' : ''}`,
    );
  }

  return warnings;
}
