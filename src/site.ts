/**
 * Multi-page site export.
 *
 * Discovery, extraction and writing are separated so a failure in one page
 * never loses the rest. A partially successful export that names its failures
 * is far more useful than an all-or-nothing crash forty pages in.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { extract, NotAFramerSiteError } from './extract.js';
import { fetchPage } from './fetch.js';
import { mapWithConcurrency, DEFAULT_CONCURRENCY } from './pool.js';
import { rewriteLinks, auditForms } from './links.js';
import {
  discoverRoutes,
  routeToFilePath,
  buildSitemap,
  buildRobots,
  type Route,
  type DiscoverOptions,
} from './routes.js';
import type { AssetMode, ExtractReport } from './types.js';

export interface SiteExportOptions extends DiscoverOptions {
  outDir: string;
  assetMode?: AssetMode;
  compileAnimations?: boolean;
  /** Public URL the export will live at, used for canonical/og:url and sitemap. */
  baseUrl?: string;
  /** Called as each page finishes, for progress output. */
  onProgress?: (done: number, total: number, route: string, ok: boolean) => void;
}

export interface PageResult {
  route: string;
  filePath: string;
  ok: boolean;
  error?: string;
  report?: ExtractReport;
  internalLinksRewritten?: number;
  formsFound?: number;
}

export interface SiteReport {
  entryUrl: string;
  origin: string;
  baseUrl?: string;
  routesDiscovered: number;
  pagesExported: number;
  pagesFailed: number;
  pages: PageResult[];
  totalBytesBefore: number;
  totalBytesAfter: number;
  totalArtifactsRemoved: number;
  totalAnimationRules: number;
  uniqueAssets: number;
  formsFound: number;
  warnings: string[];
}

/**
 * Export an entire Framer site.
 *
 * Pages are fetched with bounded concurrency because the CDN throttles, and any
 * page already fetched during discovery is reused rather than requested twice.
 */
export async function exportSite(
  entryUrl: string,
  options: SiteExportOptions,
): Promise<SiteReport> {
  const origin = new URL(entryUrl).origin;
  const outDir = resolve(options.outDir);
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const warnings: string[] = [];

  // --- discover ------------------------------------------------------------
  const discovery = await discoverRoutes(entryUrl, options);
  warnings.push(...discovery.warnings);

  const exportedRoutes = new Set(discovery.routes.map((r) => r.path));
  const assetUrls = new Set<string>();
  let done = 0;

  // --- extract each page ---------------------------------------------------
  const results = await mapWithConcurrency(
    discovery.routes,
    async (route: Route): Promise<PageResult> => {
      const filePath = routeToFilePath(route.path);
      try {
        const html = discovery.cache.get(route.path) ?? (await fetchPage(route.url));

        let internalLinksRewritten = 0;
        let formsFound = 0;

        const { html: out, report } = extract(
          html,
          {
            assetMode: options.assetMode ?? 'hotlink',
            compileAnimations: options.compileAnimations ?? true,
            baseUrl: route.url,
          },
          ($, pageWarnings) => {
            const linkResult = rewriteLinks($, {
              currentRoute: route.path,
              origin,
              exportedRoutes,
              baseUrl: options.baseUrl,
            });
            internalLinksRewritten = linkResult.internalRewritten;
            pageWarnings.push(...linkResult.warnings);

            const forms = auditForms($);
            formsFound = forms.count;
            pageWarnings.push(...forms.warnings);
          },
        );

        const target = join(outDir, filePath);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, out, 'utf8');

        for (const a of report.assets) assetUrls.add(a.url);

        done++;
        options.onProgress?.(done, discovery.routes.length, route.path, true);

        return { route: route.path, filePath, ok: true, report, internalLinksRewritten, formsFound };
      } catch (err) {
        done++;
        options.onProgress?.(done, discovery.routes.length, route.path, false);

        const message =
          err instanceof NotAFramerSiteError
            ? 'Not a Framer page (skipped)'
            : err instanceof Error
              ? err.message
              : String(err);

        return { route: route.path, filePath, ok: false, error: message };
      }
    },
    concurrency,
  );

  const pages: PageResult[] = results.map(
    (r) =>
      r.value ?? {
        route: (r.item as Route).path,
        filePath: routeToFilePath((r.item as Route).path),
        ok: false,
        error: String(r.error),
      },
  );

  // --- site-level files ----------------------------------------------------
  const okPages = pages.filter((p) => p.ok);
  const okRoutes = discovery.routes.filter((r) => okPages.some((p) => p.route === r.path));

  await writeFile(join(outDir, 'sitemap.xml'), buildSitemap(okRoutes, options.baseUrl), 'utf8');
  await writeFile(join(outDir, 'robots.txt'), buildRobots(options.baseUrl), 'utf8');

  for (const p of pages) {
    if (p.report?.warnings?.length) {
      for (const w of p.report.warnings) {
        const tagged = `${p.route}: ${w}`;
        if (!warnings.includes(tagged)) warnings.push(tagged);
      }
    }
  }

  if (!options.baseUrl) {
    warnings.push(
      'No --base-url given, so canonical and og:url tags were removed. Pass your final domain to have them rewritten instead.',
    );
  }

  const report: SiteReport = {
    entryUrl,
    origin,
    baseUrl: options.baseUrl,
    routesDiscovered: discovery.routes.length,
    pagesExported: okPages.length,
    pagesFailed: pages.length - okPages.length,
    pages,
    totalBytesBefore: sum(pages, (p) => p.report?.bytesBefore ?? 0),
    totalBytesAfter: sum(pages, (p) => p.report?.bytesAfter ?? 0),
    totalArtifactsRemoved: sum(pages, (p) =>
      (p.report?.removals ?? []).reduce((a, r) => a + r.count, 0),
    ),
    totalAnimationRules: sum(pages, (p) => p.report?.appearRulesEmitted ?? 0),
    uniqueAssets: assetUrls.size,
    formsFound: sum(pages, (p) => p.formsFound ?? 0),
    warnings,
  };

  await writeFile(
    join(outDir, 'unframer-report.json'),
    JSON.stringify(report, null, 2),
    'utf8',
  );

  return report;
}

function sum<T>(items: readonly T[], pick: (t: T) => number): number {
  return items.reduce((a, t) => a + pick(t), 0);
}
