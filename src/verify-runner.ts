/**
 * Verification harness.
 *
 * Loads the original Framer site and the export side by side in a real browser
 * and compares them. This exists because every earlier phase was verified by
 * hand, and hand-verification missed an export that left more than half a page
 * invisible.
 *
 * Three independent signals, because no single one is sufficient:
 *
 *   - **Content parity.** Visible text in the export versus the original. This
 *     is the assertion that actually catches content disappearing, and it must
 *     compare *visible* text — `innerText` returns text inside `opacity:0`
 *     elements, which is precisely how the earlier bug hid.
 *   - **Visual diff.** Pixel comparison at several viewports, catching layout
 *     and styling damage that text parity cannot see.
 *   - **Self-checks on the export.** No trackers, no badge, no external scripts,
 *     nothing stuck hidden.
 *
 * Both pages are scrolled end to end before measuring. The original hides
 * content until scrolled too, so measuring either one cold compares "whatever
 * happened to be above the fold" and proves nothing.
 */

import { chromium, type Browser, type Page } from 'playwright';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { serveDirectory } from './serve.js';
import {
  VERIFY_SCRIPT,
  CONTENT_PROBE_SCRIPT,
  SETTLE_SCRIPT,
  type VerifyResult,
  type ContentProbe,
} from './verify.js';

export const DEFAULT_VIEWPORTS = [1512, 900, 390];

export interface VerifyOptions {
  originalUrl: string;
  exportDir: string;
  routes?: string[];
  viewports?: number[];
  /** Where to write diff images. Omit to skip writing them. */
  diffDir?: string;
  /** Fraction of pixels allowed to differ before a viewport fails. */
  pixelTolerance?: number;
  /** Fraction of the original's visible text the export must retain. */
  textTolerance?: number;
  onProgress?: (message: string) => void;
}

export interface ViewportResult {
  viewport: number;
  pixelDiffRatio: number;
  diffImagePath?: string;
  original: ContentProbe;
  exported: ContentProbe;
  textRetention: number;
  selfCheck: VerifyResult;
  failures: string[];
  pass: boolean;
}

export interface RouteResult {
  route: string;
  viewports: ViewportResult[];
  pass: boolean;
  error?: string;
}

export interface VerifyReport {
  originalUrl: string;
  exportDir: string;
  routes: RouteResult[];
  pass: boolean;
  summary: {
    routesChecked: number;
    routesPassed: number;
    worstTextRetention: number;
    worstPixelDiff: number;
  };
}

/**
 * Pixel tolerance is a gross-damage tripwire, NOT a fidelity claim.
 *
 * A correct export differs from the original by construction, and inspecting a
 * real diff shows exactly why: the "Made in Framer" badge is present in the
 * original and deliberately absent from the export, and scroll-linked parallax
 * elements — which are not reconstructable from the DOM and are documented as
 * out of scope — settle at different positions. On one sampled page those two
 * causes alone account for most of an 11.7% difference at 1512px.
 *
 * Tightening this to a couple of percent would fail every correct export;
 * quietly raising it until things pass would make it meaningless. So it is set
 * to catch a page that is grossly broken, and the *hard* gates live on the
 * unambiguous signals: content parity, trackers, badge, broken images and
 * introduced markup errors.
 */
const DEFAULTS = {
  pixelTolerance: 0.25,
  textTolerance: 0.95,
};

/** Load, settle, and measure one page. */
async function measure(page: Page, url: string): Promise<ContentProbe> {
  await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
  // networkidle can never settle on a page with a live analytics socket, so it
  // is best-effort rather than required.
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  await page.evaluate(SETTLE_SCRIPT);
  return (await page.evaluate(CONTENT_PROBE_SCRIPT)) as ContentProbe;
}

/** Crop a PNG to the given height, so two images of different length compare. */
function cropToHeight(png: PNG, height: number): PNG {
  if (png.height === height) return png;
  const out = new PNG({ width: png.width, height });
  PNG.bitblt(png, out, 0, 0, png.width, height, 0, 0);
  return out;
}

/**
 * Compare two screenshots, returning the fraction of differing pixels.
 *
 * Pages routinely differ in total height, so both are cropped to the shorter of
 * the two rather than refusing to compare. Width mismatch cannot happen — both
 * render at the same viewport.
 */
function comparePngs(
  aBuf: Buffer,
  bBuf: Buffer,
): { ratio: number; diff: PNG | null } {
  const a = PNG.sync.read(aBuf);
  const b = PNG.sync.read(bBuf);

  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  if (width === 0 || height === 0) return { ratio: 1, diff: null };

  const ca = cropToHeight(a, height);
  const cb = cropToHeight(b, height);
  const diff = new PNG({ width, height });

  const differing = pixelmatch(ca.data, cb.data, diff.data, width, height, {
    threshold: 0.2,
    includeAA: false,
  });

  return { ratio: differing / (width * height), diff };
}

/**
 * Run the harness.
 *
 * The export is served over HTTP rather than opened from disk so the check
 * reflects real hosting.
 */
export async function verifyExport(options: VerifyOptions): Promise<VerifyReport> {
  const {
    originalUrl,
    exportDir,
    routes = ['/'],
    viewports = DEFAULT_VIEWPORTS,
    diffDir,
    pixelTolerance = DEFAULTS.pixelTolerance,
    textTolerance = DEFAULTS.textTolerance,
    onProgress,
  } = options;

  const server = await serveDirectory(resolve(exportDir));
  let browser: Browser | undefined;
  const routeResults: RouteResult[] = [];

  if (diffDir) await mkdir(resolve(diffDir), { recursive: true });

  try {
    browser = await chromium.launch();

    for (const route of routes) {
      const viewportResults: ViewportResult[] = [];
      let routeError: string | undefined;

      for (const width of viewports) {
        onProgress?.(`  ${route} @ ${width}px`);

        const context = await browser.newContext({
          viewport: { width, height: 900 },
          deviceScaleFactor: 1,
          // Explicitly NOT reducedMotion:'reduce'. It changes what the ORIGINAL
          // renders — Framer's own runtime leaves an element at opacity 0 under
          // reduced motion, hiding 422 characters on one sampled page — so the
          // comparison ends up measuring the export against a degraded baseline
          // and reports the export as having *more* content than the original.
          // Screenshot stability comes from `animations: 'disabled'` at capture
          // time instead, which freezes motion without touching the media query.
          reducedMotion: 'no-preference',
        });

        try {
          const originalPage = await context.newPage();
          const exportPage = await context.newPage();

          const originalUrlForRoute = new URL(route, originalUrl).toString();
          const exportUrlForRoute = new URL(route, server.url).toString();

          const original = await measure(originalPage, originalUrlForRoute);
          const exported = await measure(exportPage, exportUrlForRoute);

          const selfCheck = (await exportPage.evaluate(VERIFY_SCRIPT)) as VerifyResult;

          const shotOptions = { fullPage: true, animations: 'disabled' as const };
          const originalShot = await originalPage.screenshot(shotOptions);
          const exportShot = await exportPage.screenshot(shotOptions);

          const { ratio, diff } = comparePngs(originalShot, exportShot);

          let diffImagePath: string | undefined;
          if (diffDir && diff) {
            const name = `${route.replace(/[^a-z0-9]+/gi, '_') || 'root'}-${width}.png`;
            diffImagePath = join(resolve(diffDir), name);
            await writeFile(diffImagePath, PNG.sync.write(diff));
          }

          const textRetention =
            original.visibleTextChars === 0
              ? 1
              : exported.visibleTextChars / original.visibleTextChars;

          const failures: string[] = [...selfCheck.failures];
          if (textRetention < textTolerance) {
            failures.push(
              `visible text dropped to ${(textRetention * 100).toFixed(1)}% of the original ` +
                `(${exported.visibleTextChars} vs ${original.visibleTextChars} chars)`,
            );
          }
          if (ratio > pixelTolerance) {
            failures.push(
              `${(ratio * 100).toFixed(2)}% of pixels differ from the original — ` +
                `above the ${(pixelTolerance * 100).toFixed(0)}% gross-damage threshold, ` +
                `so this is more than badge removal and unreconstructed parallax can explain`,
            );
          }
          if (exported.imagesBroken > 0) {
            failures.push(`${exported.imagesBroken} broken image(s)`);
          }

          viewportResults.push({
            viewport: width,
            pixelDiffRatio: ratio,
            diffImagePath,
            original,
            exported,
            textRetention,
            selfCheck,
            failures,
            pass: failures.length === 0,
          });
        } catch (err) {
          routeError = err instanceof Error ? err.message : String(err);
        } finally {
          await context.close();
        }
      }

      routeResults.push({
        route,
        viewports: viewportResults,
        pass: viewportResults.length > 0 && viewportResults.every((v) => v.pass) && !routeError,
        error: routeError,
      });
    }
  } finally {
    await browser?.close();
    await server.close();
  }

  const all = routeResults.flatMap((r) => r.viewports);
  return {
    originalUrl,
    exportDir,
    routes: routeResults,
    pass: routeResults.every((r) => r.pass),
    summary: {
      routesChecked: routeResults.length,
      routesPassed: routeResults.filter((r) => r.pass).length,
      worstTextRetention: all.length ? Math.min(...all.map((v) => v.textRetention)) : 1,
      worstPixelDiff: all.length ? Math.max(...all.map((v) => v.pixelDiffRatio)) : 0,
    },
  };
}
