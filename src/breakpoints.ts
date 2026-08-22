/**
 * Breakpoint resolution.
 *
 * Framer renders *every* responsive variant into the DOM at once, wrapped in
 * `<div class="ssr-variant hidden-A hidden-B hidden-C">`. Each wrapper lists the
 * breakpoints where that copy is hidden, so the one hash NOT listed is where it
 * is visible. The `.hidden-<hash>` rules live in the breakpoint stylesheet.
 *
 * Two sources give us the hash -> media query map. We prefer the explicit
 * manifest and fall back to parsing the stylesheet, because a site missing the
 * manifest still has the CSS.
 */

import type { CheerioAPI } from 'cheerio';
import type { Breakpoint } from './types.js';

/** Key used in the appear spec for the base (unspecialised) variant. */
export const DEFAULT_VARIANT = 'default';

/**
 * Read `<script type="framer/breakpoints" id="__framer__breakpoints">`.
 * Returns [] when absent.
 */
export function parseBreakpointManifest($: CheerioAPI): Breakpoint[] {
  const raw = $('#__framer__breakpoints').first().contents().text().trim();
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (b): b is Breakpoint =>
          !!b && typeof b.hash === 'string' && typeof b.mediaQuery === 'string',
      )
      .map((b) => ({ hash: b.hash, mediaQuery: b.mediaQuery }));
  } catch {
    return [];
  }
}

/**
 * Recover breakpoints from `<style data-framer-breakpoint-css>` by reading the
 * `@media (...) { .hidden-<hash> { display:none } }` pairs.
 */
export function parseBreakpointStylesheet($: CheerioAPI): Breakpoint[] {
  const css = $('style[data-framer-breakpoint-css]').first().text();
  if (!css) return [];

  const out: Breakpoint[] = [];
  const re = /@media\s*([^{]+)\{\s*\.hidden-([A-Za-z0-9_-]+)\s*\{/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(css)) !== null) {
    out.push({ hash: m[2], mediaQuery: m[1].trim() });
  }
  return out;
}

/** Resolve breakpoints from the manifest, falling back to the stylesheet. */
export function resolveBreakpoints($: CheerioAPI): Breakpoint[] {
  const manifest = parseBreakpointManifest($);
  if (manifest.length > 0) return manifest;
  return parseBreakpointStylesheet($);
}

/**
 * Work out which breakpoints the `default` variant is responsible for.
 *
 * Framer only emits a hashed variant when that breakpoint differs from the
 * base, so `default` covers whatever is left over. Getting this wrong is what
 * leaves elements permanently invisible on the breakpoints it forgot.
 */
export function breakpointsForDefault(
  explicitHashes: string[],
  all: Breakpoint[],
): Breakpoint[] {
  const taken = new Set(explicitHashes);
  return all.filter((b) => !taken.has(b.hash));
}

/** Look up a media query by hash. */
export function mediaQueryFor(hash: string, all: Breakpoint[]): string | undefined {
  return all.find((b) => b.hash === hash)?.mediaQuery;
}
