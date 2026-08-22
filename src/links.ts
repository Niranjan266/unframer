/**
 * Link rewriting.
 *
 * A multi-page export has to work in three places: opened straight off the
 * filesystem, served from a static host, and served from a subdirectory. The
 * only form that satisfies all three is a *relative* link that names the file
 * explicitly — `../../about/index.html` rather than `/about` or `../../about/`.
 *
 * Bare directory links rely on the server resolving an index document, which
 * `file://` does not do, so they break the "just open it" case.
 */

import type { CheerioAPI } from 'cheerio';
import { routeToFilePath, routeDepth, normalizeRoute } from './routes.js';

export interface RewriteOptions {
  /** Route of the page being rewritten, e.g. "/blog/post". */
  currentRoute: string;
  /** Origin of the source site, used to recognise same-origin links. */
  origin: string;
  /** Routes included in this export. Links outside it stay absolute. */
  exportedRoutes: ReadonlySet<string>;
  /** Public base URL of the new home, used for canonical/og:url. Omit to strip them. */
  baseUrl?: string;
}

export interface RewriteResult {
  /** Same-origin links repointed at exported files. */
  internalRewritten: number;
  /** Same-origin links left absolute because the page is not in the export. */
  leftAbsolute: number;
  canonicalUpdated: number;
  warnings: string[];
}

/** `../` prefix needed to climb from a page's directory back to the site root. */
export function relativePrefix(currentRoute: string): string {
  return '../'.repeat(routeDepth(currentRoute));
}

/**
 * Build the relative href from `currentRoute` to `targetRoute`,
 * preserving any query string and fragment.
 */
export function relativeHref(
  currentRoute: string,
  targetRoute: string,
  suffix = '',
): string {
  const target = routeToFilePath(targetRoute);
  const href = `${relativePrefix(currentRoute)}${target}`;
  // A link to the page's own root must not come out as the empty string.
  return (href === '' ? 'index.html' : href) + suffix;
}

/** Split "?q=1#frag" off a URL, returning [withoutSuffix, suffix]. */
function splitSuffix(raw: string): [string, string] {
  const hashAt = raw.indexOf('#');
  const queryAt = raw.indexOf('?');
  const cut = [hashAt, queryAt].filter((i) => i >= 0).sort((a, b) => a - b)[0];
  if (cut === undefined) return [raw, ''];
  return [raw.slice(0, cut), raw.slice(cut)];
}

/**
 * Repoint every same-origin link at its exported file.
 *
 * Links to pages outside the export are rewritten to absolute URLs on the
 * original origin rather than left as root-relative paths, which would 404 on
 * the new host. That is a deliberate trade: a working link to the old site
 * beats a broken link on the new one, and it is reported so the user can see it.
 */
export function rewriteLinks($: CheerioAPI, options: RewriteOptions): RewriteResult {
  const { currentRoute, origin, exportedRoutes, baseUrl } = options;
  const result: RewriteResult = {
    internalRewritten: 0,
    leftAbsolute: 0,
    canonicalUpdated: 0,
    warnings: [],
  };
  const missing = new Set<string>();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;

    // In-page anchors, protocol links and data URIs are already correct.
    if (
      href.startsWith('#') ||
      href.startsWith('mailto:') ||
      href.startsWith('tel:') ||
      href.startsWith('data:')
    ) {
      return;
    }

    const [bare, suffix] = splitSuffix(href);
    const route = normalizeRoute(bare || currentRoute, origin);

    // Off-origin link: leave it exactly as the author wrote it.
    if (route === null) return;

    if (exportedRoutes.has(route)) {
      try {
        $(el).attr('href', relativeHref(currentRoute, route, suffix));
        result.internalRewritten++;
      } catch (err) {
        result.warnings.push(`Could not rewrite link to "${route}": ${String(err)}`);
      }
    } else {
      $(el).attr('href', new URL(route, origin).toString() + suffix);
      result.leftAbsolute++;
      missing.add(route);
    }
  });

  if (missing.size > 0) {
    const sample = [...missing].slice(0, 5).join(', ');
    result.warnings.push(
      `${missing.size} link(s) point to pages outside the export and now go to the original site: ${sample}${
        missing.size > 5 ? ' …' : ''
      }`,
    );
  }

  result.canonicalUpdated = rewriteCanonical($, currentRoute, baseUrl);
  return result;
}

/**
 * Point canonical and og:url at the new home, or remove them.
 *
 * Leaving them pointing at the Framer domain would tell search engines the
 * exported site is a duplicate of the original — which defeats self-hosting.
 */
export function rewriteCanonical(
  $: CheerioAPI,
  currentRoute: string,
  baseUrl?: string,
): number {
  let updated = 0;

  const apply = (selector: string, attr: 'href' | 'content') => {
    $(selector).each((_, el) => {
      if (baseUrl) {
        const base = baseUrl.replace(/\/$/, '');
        $(el).attr(attr, `${base}${currentRoute === '/' ? '/' : currentRoute}`);
      } else {
        $(el).remove();
      }
      updated++;
    });
  };

  apply('link[rel="canonical"]', 'href');
  apply('meta[property="og:url"]', 'content');

  return updated;
}

/**
 * Rewrite `<form action>` that posts to the origin.
 *
 * Framer forms post to Framer-hosted endpoints that stop working once the site
 * is self-hosted. We cannot invent a replacement, so we mark them and report
 * them loudly — a form that silently swallows leads is the worst outcome.
 */
export function auditForms($: CheerioAPI): { count: number; warnings: string[] } {
  const warnings: string[] = [];
  const forms = $('form');

  if (forms.length > 0) {
    forms.each((_, el) => {
      $(el).attr('data-unframer-form', 'needs-endpoint');
    });
    warnings.push(
      `${forms.length} form(s) found. Their submit endpoint belongs to the original site and stops working once self-hosted — repoint each \`action\` at your own handler (Formspree, Netlify Forms, or similar). They are marked with data-unframer-form="needs-endpoint".`,
    );
  }

  return { count: forms.length, warnings };
}
