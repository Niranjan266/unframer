/**
 * Ticker / marquee reconstruction.
 *
 * Framer server-renders tickers with a genuinely stable structure — a flex list
 * whose children carry `class="ticker-item"` plus `aria-posinset`/`aria-setsize`
 * — but the track itself ships with inline `opacity:0`, so without the runtime a
 * ticker is both invisible and motionless.
 *
 * The structure is real; the *motion parameters* are not. Speed and direction
 * live only in the compiled bundle, so those are honest defaults rather than
 * recovered values. That distinction is reported to the user rather than hidden.
 *
 * Seamless looping is done the standard way: duplicate the item set, then
 * translate the track by exactly half its own width. With a flex `gap` of G
 * between items the two halves are separated by one extra gap, so the offset is
 * `-50% - G/2` — getting this wrong produces a visible stutter each cycle.
 */

import type { CheerioAPI } from 'cheerio';

export const TICKER_ATTR = 'data-uf-ticker';

/** Framer's own class on ticker children. Stable across the builds sampled. */
const TICKER_ITEM_CLASS = 'ticker-item';

/** Seconds each item spends crossing the viewport. Tuned to look unhurried. */
const SECONDS_PER_ITEM = 4;

export interface TickerResult {
  css: string;
  /** Number of ticker tracks reconstructed. */
  tickers: number;
  warnings: string[];
}

/** Read a single declaration out of an inline style attribute. */
function readDecl(style: string | undefined, prop: string): string | undefined {
  if (!style) return undefined;
  for (const decl of style.split(';')) {
    const colon = decl.indexOf(':');
    if (colon < 0) continue;
    if (decl.slice(0, colon).trim().toLowerCase() === prop) return decl.slice(colon + 1).trim();
  }
  return undefined;
}

/** Strip the properties the CSS animation needs to own. */
function stripDecls(style: string | undefined, props: readonly string[]): string {
  if (!style) return '';
  return style
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .filter((d) => {
      const prop = d.slice(0, d.indexOf(':')).trim().toLowerCase();
      return !props.includes(prop);
    })
    .join(';');
}

/** Parse a CSS length to pixels; only px is used by Framer here. */
function pxOf(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const m = value.match(/^(-?[\d.]+)px$/);
  return m ? Number.parseFloat(m[1]) : fallback;
}

/**
 * Find every ticker, duplicate its items for a seamless loop, and annotate it.
 *
 * Must run BEFORE scroll-reveal extraction: the track's inline `opacity:0` would
 * otherwise be claimed by the reveal pass, which would make the ticker visible
 * but leave it static.
 */
export function reconstructTickers($: CheerioAPI): TickerResult {
  const warnings: string[] = [];
  const durations = new Map<string, number>();
  const gaps = new Map<string, number>();
  let tickers = 0;

  // The track is the parent of the ticker items.
  const tracks = new Set<never>();
  const seen = new Set<unknown>();

  $(`.${TICKER_ITEM_CLASS}`).each((_, item) => {
    const track = $(item).parent();
    const node = track.get(0);
    if (!node || seen.has(node)) return;
    seen.add(node);

    const items = track.children(`.${TICKER_ITEM_CLASS}`);
    if (items.length === 0) return;

    const style = track.attr('style');
    const gap = pxOf(readDecl(style, 'gap'), 0);

    // Duplicate the set so the track can translate by half its width and land
    // exactly where it started. Clones are hidden from assistive tech.
    const clones = items
      .clone()
      .attr('aria-hidden', 'true')
      .removeAttr('aria-posinset')
      .removeAttr('aria-setsize');
    track.append(clones);

    const id = `t${tickers}`;
    track.attr(TICKER_ATTR, id);

    // CSS owns opacity, transform and width from here on.
    const cleaned = stripDecls(style, ['opacity', 'transform', 'will-change', 'width', 'max-width']);
    if (cleaned) track.attr('style', cleaned);
    else track.removeAttr('style');

    durations.set(id, Math.max(8, items.length * SECONDS_PER_ITEM));
    gaps.set(id, gap);
    tickers++;
  });

  void tracks;

  if (tickers > 0) {
    warnings.push(
      `${tickers} ticker(s) reconstructed. Framer does not encode speed or direction in the page, so both are defaults — adjust --uf-ticker-duration in the generated CSS if the pace looks off.`,
    );
  }

  return { css: buildTickerCss(durations, gaps), tickers, warnings };
}

function buildTickerCss(
  durations: ReadonlyMap<string, number>,
  gaps: ReadonlyMap<string, number>,
): string {
  if (durations.size === 0) return '';

  const rules: string[] = [
    // `max-content` lets the duplicated set lay out at full width instead of
    // being squeezed into the original 100%.
    `[${TICKER_ATTR}]{opacity:1;width:max-content!important;max-width:none!important;will-change:transform;animation:uf-ticker var(--uf-ticker-duration,30s) linear infinite}`,
    // Pausing on hover is what Framer's own ticker does.
    `[${TICKER_ATTR}]:hover{animation-play-state:paused}`,
    `@media (prefers-reduced-motion:reduce){[${TICKER_ATTR}]{animation:none}}`,
  ];

  for (const [id, seconds] of durations) {
    const halfGap = (gaps.get(id) ?? 0) / 2;
    rules.push(
      `[${TICKER_ATTR}="${id}"]{--uf-ticker-duration:${seconds}s;--uf-ticker-shift:calc(-50% - ${halfGap}px)}`,
    );
  }

  rules.push(
    `@keyframes uf-ticker{from{transform:translateX(0)}to{transform:translateX(var(--uf-ticker-shift,-50%))}}`,
  );

  return rules.join('\n');
}
