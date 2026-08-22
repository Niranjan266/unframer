/**
 * Framer detection.
 *
 * We refuse to process a page we cannot positively identify as Framer output,
 * because the strip list is tightly coupled to Framer's build. Running it on
 * something else would silently mangle the page rather than fail cleanly.
 */

import type { CheerioAPI } from 'cheerio';

export interface DetectionResult {
  isFramerSite: boolean;
  /** Build hash from `<meta name="generator" content="Framer <hash>">`. */
  build?: string;
  /** Which signals fired, for diagnostics when detection is borderline. */
  signals: string[];
  confidence: number;
}

/** Signals, each worth a point. Two or more means it is a Framer site. */
export function detectFramer($: CheerioAPI, html: string): DetectionResult {
  const signals: string[] = [];
  let build: string | undefined;

  const generator = $('meta[name="generator"]').attr('content') ?? '';
  if (/^Framer\b/i.test(generator)) {
    signals.push('meta[generator]');
    const m = generator.match(/^Framer\s+(\S+)/i);
    if (m) build = m[1];
  }

  if (html.includes('framerusercontent.com')) signals.push('framerusercontent-cdn');
  if ($('#main').length > 0) signals.push('#main-root');
  if ($('style[data-framer-css-ssr-minified]').length > 0) signals.push('framer-ssr-css');
  if ($('[data-framer-name]').length > 0) signals.push('data-framer-name');
  if ($('script[data-framer-bundle]').length > 0) signals.push('framer-bundle');

  const confidence = Math.min(1, signals.length / 4);
  return { isFramerSite: signals.length >= 2, build, signals, confidence };
}
