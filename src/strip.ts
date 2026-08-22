/**
 * The strip pipeline.
 *
 * Every removal here is deliberate and recorded, so the export report can tell
 * the user exactly what left the page. Two rules govern this module:
 *
 *   - Never remove something we cannot name. Silent deletion is how exporters
 *     ship broken pages.
 *   - Keep the user's own custom code. Framer has headStart/bodyStart slots
 *     where people put their own scripts; we strip known trackers out of those
 *     but do not clear the slots wholesale.
 */

import type { CheerioAPI } from 'cheerio';
import type { RemovalRecord } from './types.js';

/**
 * Third-party analytics and pixel hosts. Matched against script `src` and
 * against inline script bodies for the snippet-style loaders.
 */
const TRACKER_HOSTS = [
  'events.framer.com',
  'google-analytics.com',
  'googletagmanager.com',
  'analytics.google.com',
  'doubleclick.net',
  'connect.facebook.net',
  'facebook.com/tr',
  'static.hotjar.com',
  'script.hotjar.com',
  'cdn.segment.com',
  'plausible.io',
  'cdn.mxpnl.com',
  'clarity.ms',
  'sentry-cdn.com',
  'browser.sentry-cdn.com',
  'fullstory.com',
  'intercom.io',
  'matomo.cloud',
  'posthog.com',
  'amplitude.com',
  'tiktok.com/i18n/pixel',
  'snap.licdn.com',
  'ct.pinterest.com',
];

/** Inline-script fingerprints that indicate a tracker bootstrap. */
const TRACKER_INLINE_PATTERNS = [
  /gtag\s*\(/,
  /dataLayer\s*\.\s*push/,
  /GoogleAnalyticsObject/,
  /fbq\s*\(/,
  /_linkedin_partner_id/,
  /hj\s*\(\s*['"]/,
  /mixpanel\s*\.\s*init/,
  /posthog\s*\.\s*init/,
  /clarity\s*\(/,
];

/** CSS rules that draw the platform badge. */
const BADGE_CSS_PATTERNS = [
  /#__framer-badge-container\s*\{[^}]*\}/g,
  /\.__framer-badge\s*\{[^}]*\}/g,
  /#__framer-badge-container[^{]*\{[^}]*\}/g,
];

export interface StripResult {
  removals: RemovalRecord[];
  warnings: string[];
}

function record(removals: RemovalRecord[], kind: string, detail: string, count: number) {
  if (count > 0) removals.push({ kind, detail, count });
}

/** Remove Framer's own analytics beacon. */
function stripFramerAnalytics($: CheerioAPI, removals: RemovalRecord[]) {
  const sel = $('script[src*="events.framer.com"]');
  const n = sel.length;
  sel.remove();
  record(removals, 'tracker', 'Framer analytics (events.framer.com)', n);
}

/** Remove third-party analytics and pixels, including inline bootstraps. */
function stripThirdPartyTrackers($: CheerioAPI, removals: RemovalRecord[]) {
  let external = 0;
  let inline = 0;

  $('script[src]').each((_, el) => {
    const src = $(el).attr('src') ?? '';
    if (TRACKER_HOSTS.some((h) => src.includes(h))) {
      $(el).remove();
      external++;
    }
  });

  $('script:not([src])').each((_, el) => {
    const body = $(el).html() ?? '';
    if (!body.trim()) return;
    if (TRACKER_INLINE_PATTERNS.some((re) => re.test(body))) {
      $(el).remove();
      inline++;
    }
  });

  // Tracking pixels dropped in as <img> or <noscript><img>.
  let pixels = 0;
  $('img[src], noscript img[src]').each((_, el) => {
    const src = $(el).attr('src') ?? '';
    if (TRACKER_HOSTS.some((h) => src.includes(h))) {
      $(el).remove();
      pixels++;
    }
  });

  record(removals, 'tracker', 'Third-party analytics scripts', external);
  record(removals, 'tracker', 'Inline tracker bootstraps', inline);
  record(removals, 'tracker', 'Tracking pixels', pixels);
}

/** Remove the React/Motion runtime and everything that exists only to load it. */
function stripRuntime($: CheerioAPI, removals: RemovalRecord[]) {
  const bundle = $('script[data-framer-bundle]');
  const bundleCount = bundle.length;
  bundle.remove();
  record(removals, 'runtime', 'Framer main bundle (React + Motion)', bundleCount);

  const preloads = $('link[rel="modulepreload"]');
  const preloadCount = preloads.length;
  preloads.remove();
  record(removals, 'runtime', 'Module preload hints', preloadCount);

  // Any remaining module script pointing at the site bundle directory.
  let strays = 0;
  $('script[type="module"][src]').each((_, el) => {
    const src = $(el).attr('src') ?? '';
    if (/framerusercontent\.com\/sites\/.*\.mjs/.test(src)) {
      $(el).remove();
      strays++;
    }
  });
  record(removals, 'runtime', 'Stray runtime module scripts', strays);
}

/**
 * Remove the inline bootstraps Framer emits alongside the runtime. These are
 * matched on distinctive internals rather than position, so reordering in a
 * future Framer build does not silently leave them behind.
 */
function stripRuntimeBootstraps($: CheerioAPI, removals: RemovalRecord[]) {
  const FINGERPRINTS = [
    'animateAppearEffects',
    '__framer_disable_appear_effects_optimization__',
    'startOptimizedAppearAnimation',
    'window.__framer__breakpoints',
  ];

  let n = 0;
  $('script:not([src])').each((_, el) => {
    const body = $(el).html() ?? '';
    if (!body.trim()) return;
    if (FINGERPRINTS.some((f) => body.includes(f))) {
      $(el).remove();
      n++;
    }
  });
  record(removals, 'runtime', 'Appear-animation bootstrap', n);

  // NODE_ENV shim exists purely for the React bundle.
  let shims = 0;
  $('script:not([src])').each((_, el) => {
    const body = $(el).html() ?? '';
    if (body.includes('window.process') && body.includes('NODE_ENV')) {
      $(el).remove();
      shims++;
    }
  });
  record(removals, 'runtime', 'React NODE_ENV shim', shims);

  const preserve = $('script[data-preserve-internal-params]');
  const pc = preserve.length;
  preserve.remove();
  record(removals, 'runtime', 'Framer query-param preserver', pc);

  const appearAnim = $('script[data-framer-appear-animation]');
  const ac = appearAnim.length;
  appearAnim.remove();
  record(removals, 'runtime', 'Appear-animation marker script', ac);
}

/**
 * Remove the data islands. Callers MUST have already parsed the appear spec and
 * breakpoints out of these before stripping, or the animations are lost.
 */
function stripDataIslands($: CheerioAPI, removals: RemovalRecord[]) {
  const types = [
    ['script[type="framer/appear"]', 'Appear animation data (compiled to CSS)'],
    ['script[type="framer/breakpoints"]', 'Breakpoint manifest (compiled to CSS)'],
    ['script[type="framer/handover"]', 'CMS handover payload'],
  ] as const;

  for (const [sel, detail] of types) {
    const found = $(sel);
    const n = found.length;
    found.remove();
    record(removals, 'data-island', detail, n);
  }
}

/**
 * Remove code that calls back to the platform.
 *
 * Framer inlines a snippet that preloads `framer.com/edit/init.mjs` whenever a
 * localStorage flag is set, to bring up its editor bar. On a self-hosted copy
 * that is purely a request home, and it survives even in high-fidelity mode
 * where the rest of the runtime is deliberately kept — so it is stripped
 * separately from the runtime itself.
 */
function stripPhoneHome($: CheerioAPI, removals: RemovalRecord[]) {
  const FINGERPRINTS = ['framer.com/edit/', '__framer_force_showing_editorbar'];

  let n = 0;
  $('script:not([src])').each((_, el) => {
    const body = $(el).html() ?? '';
    if (!body.trim()) return;
    if (FINGERPRINTS.some((f) => body.includes(f))) {
      $(el).remove();
      n++;
    }
  });

  // Any preload someone left pointing at the editor.
  const links = $('link[href*="framer.com/edit"]');
  const linkCount = links.length;
  links.remove();

  record(removals, 'phone-home', 'Framer editor bootstrap', n + linkCount);
}

/** Remove the platform watermark container and any leftover badge markup. */
function stripBadge($: CheerioAPI, removals: RemovalRecord[]) {
  const container = $('#__framer-badge-container');
  const n = container.length;
  container.remove();

  const stray = $('.__framer-badge, a[href*="framer.com/?via"], a[href="https://www.framer.com"][title*="Framer"]');
  const strayCount = stray.length;
  stray.remove();

  record(removals, 'watermark', 'Framer badge container', n);
  record(removals, 'watermark', 'Badge markup', strayCount);
}

/** Strip the badge's CSS so the output carries no trace of it. */
function stripBadgeCss($: CheerioAPI, removals: RemovalRecord[]) {
  let ruleCount = 0;

  $('style').each((_, el) => {
    const css = $(el).html();
    if (!css || !css.includes('__framer-badge')) return;

    let next = css;
    for (const re of BADGE_CSS_PATTERNS) {
      next = next.replace(re, () => {
        ruleCount++;
        return '';
      });
    }
    if (next !== css) $(el).html(next);
  });

  record(removals, 'watermark', 'Badge CSS rules', ruleCount);
}

/** Remove metadata that points back at Framer-hosted services. */
function stripFramerMetadata($: CheerioAPI, removals: RemovalRecord[]) {
  const selectors = [
    ['meta[name="framer-search-index"]', 'Search index pointer'],
    ['meta[name="framer-search-index-fallback"]', 'Search index fallback pointer'],
    ['meta[name="framer-html-plugin"]', 'Framer HTML plugin flag'],
    ['meta[name="generator"][content^="Framer"]', 'Generator fingerprint'],
  ] as const;

  for (const [sel, detail] of selectors) {
    const found = $(sel);
    const n = found.length;
    found.remove();
    record(removals, 'metadata', detail, n);
  }
}

/**
 * Run the full strip.
 *
 * Order matters: data islands are removed last among the script passes so that
 * bootstrap fingerprint matching still sees a coherent document, and badge CSS
 * is cleaned after the badge node itself.
 */
export function stripAll($: CheerioAPI, keepRuntime = false): StripResult {
  const removals: RemovalRecord[] = [];
  const warnings: string[] = [];

  // Trackers and the watermark go in every mode — they are the point.
  stripFramerAnalytics($, removals);
  stripThirdPartyTrackers($, removals);
  stripPhoneHome($, removals);

  // The runtime, its bootstraps and the data islands it reads are one unit.
  // Removing any of them while keeping the others produces a page that tries
  // to hydrate against data that is no longer there.
  if (!keepRuntime) {
    stripRuntime($, removals);
    stripRuntimeBootstraps($, removals);
    stripDataIslands($, removals);
  }

  stripBadge($, removals);
  stripBadgeCss($, removals);
  stripFramerMetadata($, removals);

  if (keepRuntime) {
    // The badge is injected at runtime, so removing the node is not enough
    // once the runtime is still running. Hide it by rule instead.
    $('head').append(
      '<style data-unframer="badge">#__framer-badge-container,.__framer-badge{display:none!important}</style>',
    );
    removals.push({
      kind: 'watermark',
      detail: 'Badge suppressed by rule (runtime kept)',
      count: 1,
    });
  }

  // `#svg-templates` holds SVG defs referenced by <use> elsewhere in the page.
  // Removing it looks tempting because it is invisible, but it breaks icons.
  if ($('#svg-templates').length > 0) {
    warnings.push('Kept #svg-templates: referenced by <use> elements.');
  }

  return { removals, warnings };
}
