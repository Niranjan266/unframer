/**
 * Public API.
 *
 * The CLI is one consumer of this; embedding the engine in your own tool is
 * equally supported. Everything re-exported here is considered stable enough to
 * depend on — internals not listed are free to change.
 *
 * ```ts
 * import { extract, exportSite } from 'unframer';
 *
 * const { html, report } = extract(await fetchPage(url));
 * const site = await exportSite(url, { outDir: 'dist', assetMode: 'offline' });
 * ```
 */

// --- single page ------------------------------------------------------------
export { extract, NotAFramerSiteError, type ExtractResult, type DocumentHook } from './extract.js';
export { detectFramer, type DetectionResult } from './detect.js';
export { stripAll, type StripResult } from './strip.js';

// --- animation --------------------------------------------------------------
export {
  parseAppearSpec,
  compileAppearCss,
  neutralizeInlineInitialState,
  buildTransform,
  APPEAR_ATTR,
  type CompileResult,
} from './appear.js';
export { toCssEasing, springToLinearEasing } from './easing.js';
export {
  resolveBreakpoints,
  breakpointsForDefault,
  mediaQueryFor,
  DEFAULT_VARIANT,
} from './breakpoints.js';

// --- interactions -----------------------------------------------------------
export { extractScrollReveals, REVEAL_ATTR, REVEAL_VISIBLE_CLASS, type RevealResult } from './reveal.js';
export { reconstructTickers, TICKER_ATTR, type TickerResult } from './ticker.js';
export { HEAD_SHIM, BODY_SHIM, shimBytes } from './shim.js';

// --- whole site -------------------------------------------------------------
export { exportSite, type SiteExportOptions, type SiteReport, type PageResult } from './site.js';
export {
  discoverRoutes,
  routeToFilePath,
  routeDepth,
  normalizeRoute,
  buildSitemap,
  buildRobots,
  type Route,
  type DiscoverOptions,
} from './routes.js';
export { rewriteLinks, rewriteCanonical, auditForms, relativeHref } from './links.js';

// --- assets -----------------------------------------------------------------
export { inventoryAssets, parseSrcset, extractCssUrls } from './assets.js';
export { downloadAssets, localNameFor, type DownloadResult } from './download.js';
export { localizeAssets, localizeMetaImages, rewriteCssUrls } from './localize.js';

// --- verification -----------------------------------------------------------
export {
  VERIFY_SCRIPT,
  CONTENT_PROBE_SCRIPT,
  SETTLE_SCRIPT,
  VERIFY_VIEWPORTS,
  formatVerifyResult,
  type VerifyResult,
  type ContentProbe,
} from './verify.js';
export { verifyExport, DEFAULT_VIEWPORTS, type VerifyOptions, type VerifyReport } from './verify-runner.js';
export {
  validateHtmlFiles,
  validateHtmlStrings,
  validateAgainstBaseline,
  type ValidationResult,
  type HtmlIssue,
} from './validate-html.js';

// --- serving and packaging --------------------------------------------------
export { startServer, type ServerOptions, type RunningServer } from './server.js';
export { serveDirectory, type StaticServer } from './serve.js';
export { ExportQueue, toJobView, type Job, type JobView, type JobOptions } from './queue.js';
export {
  packageExport,
  createZip,
  writeHostConfigs,
  listFiles,
  type ZipResult,
} from './package.js';
export { assertPublicUrl, isPrivateAddress, BlockedUrlError } from './ssrf.js';

// --- utilities --------------------------------------------------------------
export { fetchPage, fetchWithRetry, fetchSitemapRoutes } from './fetch.js';
export { mapWithConcurrency, DEFAULT_CONCURRENCY } from './pool.js';

export type {
  ExtractOptions,
  ExtractReport,
  AssetMode,
  AssetRef,
  Breakpoint,
  AppearSpec,
  AppearVariant,
  AppearState,
  AppearTransition,
  RemovalRecord,
} from './types.js';
export { DEFAULT_OPTIONS } from './types.js';
