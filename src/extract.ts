/**
 * Extraction orchestrator.
 *
 * Sequencing is the whole game here. The appear spec and breakpoint manifest
 * must be READ before the strip pass deletes them, and the compiled CSS must be
 * injected before the inline initial state is neutralised — otherwise there is
 * a window where elements have neither their inline state nor a rule to drive
 * them, which is precisely the invisible-page failure this project exists to
 * avoid.
 */

import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type { ExtractOptions, ExtractReport } from './types.js';
import { DEFAULT_OPTIONS } from './types.js';
import { detectFramer } from './detect.js';
import { resolveBreakpoints } from './breakpoints.js';
import {
  parseAppearSpec,
  compileAppearCss,
  neutralizeInlineInitialState,
  forceVisibleCss,
  APPEAR_ATTR,
} from './appear.js';
import { stripAll } from './strip.js';
import { inventoryAssets, normalizeProtocolRelative } from './assets.js';
import { extractScrollReveals, REVEAL_ATTR } from './reveal.js';
import { reconstructTickers } from './ticker.js';
import { HEAD_SHIM, BODY_SHIM, shimBytes } from './shim.js';

export interface ExtractResult {
  html: string;
  report: ExtractReport;
}

/**
 * Hook invoked with the parsed document just before serialisation.
 *
 * Multi-page concerns (link rewriting, canonical retargeting) need the DOM, and
 * this lets them run without a second parse of a page that can be close to a
 * megabyte. Anything the hook wants to report goes into `warnings`.
 */
export type DocumentHook = (
  $: CheerioAPI,
  warnings: string[],
) => void;

export class NotAFramerSiteError extends Error {
  constructor(public readonly signals: string[]) {
    super(
      `This does not look like a published Framer site (signals found: ${
        signals.length ? signals.join(', ') : 'none'
      }). Refusing to run the Framer strip pipeline on it.`,
    );
    this.name = 'NotAFramerSiteError';
  }
}

/** Inject the compiled animation stylesheet at the end of <head>. */
function injectCss($: CheerioAPI, css: string, marker: string): void {
  if (!css.trim()) return;
  const style = `<style data-unframer="${marker}">${css}</style>`;
  const head = $('head');
  if (head.length > 0) head.append(style);
  else $.root().prepend(style);
}

/** Leave a short provenance comment so the output is self-describing. */
function injectProvenance($: CheerioAPI, report: ExtractReport): void {
  const stripped = report.removals.reduce((a, r) => a + r.count, 0);
  const note = `\n  Exported with Unframer — portable static output.\n  ${stripped} platform artifact(s) removed; ${report.appearRulesEmitted} animation rule(s) compiled to CSS.\n`;
  $('head').prepend(`<!--${note}-->`);
}

/**
 * Turn a published Framer page into portable static HTML.
 *
 * @throws NotAFramerSiteError when the input is not recognisably Framer output.
 */
export function extract(
  html: string,
  options: Partial<ExtractOptions> = {},
  onDocument?: DocumentHook,
): ExtractResult {
  const opts: ExtractOptions = { ...DEFAULT_OPTIONS, ...options };
  // Default (parse5) load: spec-correct parsing and serialisation, which
  // matters because the output has to survive W3C validation.
  const $ = cheerio.load(html);

  const detection = detectFramer($, html);
  if (!detection.isFramerSite) {
    throw new NotAFramerSiteError(detection.signals);
  }

  // --- read the declarative data BEFORE anything strips it -----------------
  const breakpoints = resolveBreakpoints($);
  const appearSpec = parseAppearSpec($);
  const appearIds = Object.keys(appearSpec).length;
  const animatedElements = $(`[${APPEAR_ATTR}]`).length;

  const warnings: string[] = [];
  let appearRulesEmitted = 0;

  if (opts.compileAnimations && appearIds > 0) {
    const compiled = compileAppearCss(appearSpec, breakpoints, opts.reducedMotion);
    injectCss($, compiled.css, 'appear');
    appearRulesEmitted = compiled.rulesEmitted;
    warnings.push(...compiled.warnings);

    if (breakpoints.length === 0 && appearIds > 0) {
      warnings.push(
        'No breakpoint manifest found; responsive animation variants could not be scoped.',
      );
    }
  } else if (appearIds > 0 || animatedElements > 0) {
    // Not compiling, but the inline initial state still has to go or the page
    // renders blank. Force the final state instead.
    injectCss($, forceVisibleCss(), 'appear-disabled');
  }

  // Safe to remove the inline pre-animation state now that CSS is in place.
  const neutralized = animatedElements > 0 ? neutralizeInlineInitialState($) : 0;

  // --- interactions --------------------------------------------------------
  // Only a subset of hidden elements carry appear data. The rest are revealed
  // by Framer's runtime, so without this pass they stay invisible forever.
  let scrollReveals = 0;
  let revealGroups = 0;
  let tickers = 0;
  let shimSize = 0;

  if (opts.interactions) {
    // Tickers first: their track is hidden inline too, and the reveal pass
    // would otherwise claim it and leave the ticker visible but motionless.
    const tickerResult = reconstructTickers($);
    const revealResult = extractScrollReveals($);

    tickers = tickerResult.tickers;
    scrollReveals = revealResult.elements;
    revealGroups = revealResult.groups;
    warnings.push(...tickerResult.warnings);

    injectCss($, [tickerResult.css, revealResult.css].filter(Boolean).join('\n'), 'interactions');
  } else {
    // Not reconstructing, but nothing may be left invisible either.
    injectCss(
      $,
      `[style*="opacity:0"]{opacity:1!important}`,
      'interactions-disabled',
    );
  }

  // --- strip ---------------------------------------------------------------
  const { removals, warnings: stripWarnings } = stripAll($);
  warnings.push(...stripWarnings);

  // Shim goes in after the strip pass so it cannot be swept up by it.
  // The head half must be synchronous and first, or hidden elements paint
  // visible for a frame before the class lands.
  if (opts.interactions && $(`[${REVEAL_ATTR}]`).length > 0) {
    $('head').prepend(`<script data-unframer="shim-head">${HEAD_SHIM}</script>`);
    $('body').append(`<script data-unframer="shim">${BODY_SHIM}</script>`);
    shimSize = shimBytes();
  }

  // --- assets --------------------------------------------------------------
  const protocolFixes = normalizeProtocolRelative($);
  if (protocolFixes > 0) {
    removals.push({
      kind: 'rewrite',
      detail: 'Protocol-relative URLs normalised to https',
      count: protocolFixes,
    });
  }
  const assets = inventoryAssets($);

  // Offline localisation happens in the multi-page orchestrator, which is the
  // only layer that sees the whole site and can download each asset once.

  const report: ExtractReport = {
    isFramerSite: true,
    framerBuild: detection.build,
    bytesBefore: Buffer.byteLength(html, 'utf8'),
    bytesAfter: 0,
    removals,
    breakpoints,
    appearIds,
    appearRulesEmitted,
    animatedElements: neutralized,
    scrollReveals,
    revealGroups,
    tickers,
    shimBytes: shimSize,
    assets,
    warnings,
    sourceUrl: opts.baseUrl,
  };

  // Multi-page concerns run last, once the document is otherwise final.
  if (onDocument) onDocument($, warnings);

  injectProvenance($, report);

  const out = $.html();
  report.bytesAfter = Buffer.byteLength(out, 'utf8');

  return { html: out, report };
}
