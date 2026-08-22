/**
 * Multi-page site export.
 *
 * Four phases, in order, because offline asset mode needs the whole site in
 * hand before it can download anything:
 *
 *   A. discover routes
 *   B. fetch every page (reusing whatever discovery already pulled)
 *   C. offline only — inventory assets across all pages, download once
 *   D. extract, rewrite and write each page
 *
 * Splitting B from D is what lets an asset referenced on forty pages be
 * downloaded a single time. Failures are captured per page rather than thrown,
 * so one dead route cannot lose the other thirty-nine.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import * as cheerio from 'cheerio';
import { extract, NotAFramerSiteError } from './extract.js';
import { fetchPage } from './fetch.js';
import { mapWithConcurrency, DEFAULT_CONCURRENCY } from './pool.js';
import { rewriteLinks, auditForms } from './links.js';
import { inventoryAssets } from './assets.js';
import { downloadAssets, type DownloadResult } from './download.js';
import { localizeAssets, localizeMetaImages, auditRemoteStylesheets } from './localize.js';
import {
  discoverRoutes,
  routeToFilePath,
  buildSitemap,
  buildRobots,
  type Route,
  type DiscoverOptions,
} from './routes.js';
import type { AssetMode, AssetRef, ExtractReport } from './types.js';

export interface SiteExportOptions extends DiscoverOptions {
  outDir: string;
  assetMode?: AssetMode;
  compileAnimations?: boolean;
  /** Keep Framer's runtime for full-fidelity animation and interaction. */
  keepRuntime?: boolean;
  /** Public URL the export will live at, used for canonical/og:url and sitemap. */
  baseUrl?: string;
  onProgress?: (done: number, total: number, route: string, ok: boolean) => void;
  onAssetProgress?: (done: number, total: number, url: string, ok: boolean) => void;
}

export interface PageResult {
  route: string;
  filePath: string;
  ok: boolean;
  error?: string;
  report?: ExtractReport;
  internalLinksRewritten?: number;
  assetsLocalized?: number;
  formsFound?: number;
}

export interface SiteReport {
  entryUrl: string;
  origin: string;
  baseUrl?: string;
  assetMode: AssetMode;
  routesDiscovered: number;
  pagesExported: number;
  pagesFailed: number;
  pages: PageResult[];
  totalBytesBefore: number;
  totalBytesAfter: number;
  totalArtifactsRemoved: number;
  totalAnimationRules: number;
  uniqueAssets: number;
  assetsDownloaded: number;
  assetsFailed: number;
  assetBytes: number;
  formsFound: number;
  warnings: string[];
}

export async function exportSite(
  entryUrl: string,
  options: SiteExportOptions,
): Promise<SiteReport> {
  const origin = new URL(entryUrl).origin;
  const outDir = resolve(options.outDir);
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const assetMode: AssetMode = options.assetMode ?? 'hotlink';
  const warnings: string[] = [];

  // --- A. discover ---------------------------------------------------------
  const discovery = await discoverRoutes(entryUrl, options);
  warnings.push(...discovery.warnings);

  const exportedRoutes = new Set(discovery.routes.map((r) => r.path));

  // --- B. make sure every page is in hand ----------------------------------
  const pageHtml = new Map<string, string>(discovery.cache);
  const missing = discovery.routes.filter((r) => !pageHtml.has(r.path));

  if (missing.length > 0) {
    const fetched = await mapWithConcurrency(
      missing,
      (route) => fetchPage(route.url),
      concurrency,
    );
    for (let i = 0; i < fetched.length; i++) {
      if (fetched[i].value) pageHtml.set(missing[i].path, fetched[i].value!);
    }
  }

  // --- C. offline assets ---------------------------------------------------
  let assetMap = new Map<string, string>();
  let download: DownloadResult | undefined;
  const allAssets = new Map<string, AssetRef>();

  for (const route of discovery.routes) {
    const html = pageHtml.get(route.path);
    if (!html) continue;
    for (const asset of inventoryAssets(cheerio.load(html), options.keepRuntime ?? false)) {
      if (!allAssets.has(asset.url)) allAssets.set(asset.url, asset);
    }
  }

  if (assetMode === 'offline') {
    download = await downloadAssets([...allAssets.values()], outDir, {
      concurrency,
      onProgress: options.onAssetProgress,
    });
    assetMap = download.map;
    warnings.push(...download.warnings);
  }

  // --- D. extract, rewrite, write -----------------------------------------
  let done = 0;
  const results = await mapWithConcurrency(
    discovery.routes,
    async (route: Route): Promise<PageResult> => {
      const filePath = routeToFilePath(route.path);
      try {
        const html = pageHtml.get(route.path) ?? (await fetchPage(route.url));

        let internalLinksRewritten = 0;
        let assetsLocalized = 0;
        let formsFound = 0;

        const { html: out, report } = extract(
          html,
          {
            assetMode,
            compileAnimations: options.compileAnimations ?? true,
            keepRuntime: options.keepRuntime ?? false,
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

            if (assetMode === 'offline' && assetMap.size > 0) {
              const localized = localizeAssets($, assetMap, route.path);
              const meta = localizeMetaImages($, assetMap, options.baseUrl);
              assetsLocalized = localized.rewritten + meta.rewritten;

              if (meta.needsBaseUrl > 0) {
                pageWarnings.push(
                  `${meta.needsBaseUrl} social preview image(s) still point at the original CDN. Crawlers need an absolute URL, so pass --base-url to have them rewritten to your domain.`,
                );
              }
              pageWarnings.push(...auditRemoteStylesheets($));
            }

            const forms = auditForms($);
            formsFound = forms.count;
            pageWarnings.push(...forms.warnings);
          },
        );

        const target = join(outDir, filePath);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, out, 'utf8');

        done++;
        options.onProgress?.(done, discovery.routes.length, route.path, true);

        return {
          route: route.path,
          filePath,
          ok: true,
          report,
          internalLinksRewritten,
          assetsLocalized,
          formsFound,
        };
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

  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'sitemap.xml'), buildSitemap(okRoutes, options.baseUrl), 'utf8');
  await writeFile(join(outDir, 'robots.txt'), buildRobots(options.baseUrl), 'utf8');

  for (const p of pages) {
    for (const w of p.report?.warnings ?? []) {
      const tagged = `${p.route}: ${w}`;
      if (!warnings.includes(tagged)) warnings.push(tagged);
    }
  }

  if (!options.baseUrl) {
    warnings.push(
      'No --base-url given, so canonical and og:url tags were removed. Pass your final domain to have them rewritten instead.',
    );
  }
  if (assetMode === 'hotlink') {
    warnings.push(
      'Assets are hotlinked from framerusercontent. Pass --offline for a fully portable package.',
    );
  }

  const report: SiteReport = {
    entryUrl,
    origin,
    baseUrl: options.baseUrl,
    assetMode,
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
    uniqueAssets: allAssets.size,
    assetsDownloaded: download?.downloaded.length ?? 0,
    assetsFailed: download?.failed.length ?? 0,
    assetBytes: download?.totalBytes ?? 0,
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
