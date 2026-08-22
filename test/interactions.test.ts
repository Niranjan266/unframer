/**
 * Tests for the interaction shim.
 *
 * The regression these guard against is the worst one this project has had:
 * an export that stripped the runtime and left more than half the page
 * invisible, while the test suite passed clean because it only ever looked at
 * `[data-framer-appear-id]` elements.
 */

import { describe, it, expect } from 'vitest';
import * as cheerio from 'cheerio';
import { extractScrollReveals, REVEAL_ATTR, REVEAL_VISIBLE_CLASS } from '../src/reveal.js';
import { reconstructTickers, TICKER_ATTR } from '../src/ticker.js';
import { HEAD_SHIM, BODY_SHIM } from '../src/shim.js';
import { APPEAR_ATTR } from '../src/appear.js';

describe('extractScrollReveals', () => {
  it('annotates an element hidden by inline opacity', () => {
    const $ = cheerio.load('<div style="opacity:0;transform:translateY(50px)">Hi</div>');
    const r = extractScrollReveals($);
    expect(r.elements).toBe(1);
    expect($('div').attr(REVEAL_ATTR)).toBe('r0');
  });

  it('removes the inline hidden state so CSS can own it', () => {
    const $ = cheerio.load(
      '<div style="will-change:transform;opacity:0;transform:translateY(50px)">Hi</div>',
    );
    extractScrollReveals($);
    expect($('div').attr('style')).toBeUndefined();
  });

  it('keeps unrelated inline properties', () => {
    const $ = cheerio.load('<div style="opacity:0;background-color:red;display:flex">Hi</div>');
    extractScrollReveals($);
    const style = $('div').attr('style') ?? '';
    expect(style).toContain('background-color:red');
    expect(style).toContain('display:flex');
    expect(style).not.toContain('opacity');
  });

  /** The appear compiler owns those; two systems fighting over one element breaks both. */
  it('skips elements owned by the appear compiler', () => {
    const $ = cheerio.load(
      `<div ${APPEAR_ATTR}="x" style="opacity:0.001;transform:translateY(-20px)"></div>`,
    );
    const r = extractScrollReveals($);
    expect(r.elements).toBe(0);
    expect($('div').attr(REVEAL_ATTR)).toBeUndefined();
  });

  /** Framer uses partial opacity as deliberate design, not as a hidden state. */
  it('leaves deliberately translucent elements alone', () => {
    const $ = cheerio.load('<div style="opacity:0.6">Dimmed</div>');
    expect(extractScrollReveals($).elements).toBe(0);
    expect($('div').attr('style')).toBe('opacity:0.6');
  });

  it('deduplicates identical from-states into one rule', () => {
    const $ = cheerio.load(
      '<div style="opacity:0;transform:translateY(50px)">a</div>' +
        '<div style="opacity:0;transform:translateY(50px)">b</div>' +
        '<div style="opacity:0;transform:translateY(20px)">c</div>',
    );
    const r = extractScrollReveals($);
    expect(r.elements).toBe(3);
    expect(r.groups).toBe(2);
  });

  it('carries filter into the from-state', () => {
    const $ = cheerio.load('<div style="opacity:0;filter:blur(10px)">a</div>');
    const r = extractScrollReveals($);
    expect(r.css).toContain('filter:blur(10px)');
  });

  /**
   * The safety property the whole design rests on: every hidden rule is gated
   * behind .uf-js, so without the shim the page renders fully visible.
   */
  it('gates every hidden rule behind .uf-js', () => {
    const $ = cheerio.load('<div style="opacity:0">a</div>');
    const { css } = extractScrollReveals($);
    const hiddenRules = css
      .split('\n')
      .filter((line) => /\{[^}]*opacity:0/.test(line) && !line.includes('prefers-reduced-motion'));
    expect(hiddenRules.length).toBeGreaterThan(0);
    for (const rule of hiddenRules) expect(rule).toContain('.uf-js');
  });

  it('emits a visible rule and a reduced-motion escape hatch', () => {
    const $ = cheerio.load('<div style="opacity:0">a</div>');
    const { css } = extractScrollReveals($);
    expect(css).toContain(`[${REVEAL_ATTR}].${REVEAL_VISIBLE_CLASS}`);
    expect(css).toContain('prefers-reduced-motion:reduce');
  });

  it('emits nothing when there is nothing hidden', () => {
    const $ = cheerio.load('<div style="display:flex">a</div>');
    const r = extractScrollReveals($);
    expect(r.elements).toBe(0);
    expect(r.css).toBe('');
  });
});

describe('reconstructTickers', () => {
  const ticker = (gap = '20px', items = 3) =>
    `<ul style="display:flex;gap:${gap};opacity:0;width:100%;transform:translateX(-20px)">` +
    Array.from({ length: items }, (_, i) => `<li class="ticker-item" aria-posinset="${i + 1}" aria-setsize="${items}">i${i}</li>`).join('') +
    '</ul>';

  it('finds the track and annotates it', () => {
    const $ = cheerio.load(ticker());
    const r = reconstructTickers($);
    expect(r.tickers).toBe(1);
    expect($('ul').attr(TICKER_ATTR)).toBe('t0');
  });

  /** Half-width translation only lands seamlessly if the set is duplicated. */
  it('duplicates the item set for a seamless loop', () => {
    const $ = cheerio.load(ticker('20px', 3));
    reconstructTickers($);
    expect($('li.ticker-item')).toHaveLength(6);
  });

  it('hides the clones from assistive technology', () => {
    const $ = cheerio.load(ticker('20px', 2));
    reconstructTickers($);
    expect($('li[aria-hidden="true"]')).toHaveLength(2);
  });

  it('removes the inline state that CSS now owns', () => {
    const $ = cheerio.load(ticker());
    reconstructTickers($);
    const style = $('ul').attr('style') ?? '';
    expect(style).not.toContain('opacity');
    expect(style).not.toContain('transform');
    expect(style).not.toContain('width');
    expect(style).toContain('display:flex');
  });

  /** Off-by-one-gap here produces a visible stutter every cycle. */
  it('offsets the loop by half the gap', () => {
    const $ = cheerio.load(ticker('20px'));
    const { css } = reconstructTickers($);
    expect(css).toContain('calc(-50% - 10px)');
  });

  it('handles a track with no gap', () => {
    const $ = cheerio.load(ticker('0px'));
    const { css } = reconstructTickers($);
    expect(css).toContain('calc(-50% - 0px)');
  });

  it('scales duration with item count', () => {
    const { css } = reconstructTickers(cheerio.load(ticker('20px', 10)));
    expect(css).toMatch(/--uf-ticker-duration:40s/);
  });

  it('pauses on hover and respects reduced motion', () => {
    const { css } = reconstructTickers(cheerio.load(ticker()));
    expect(css).toContain('animation-play-state:paused');
    expect(css).toContain('prefers-reduced-motion:reduce');
  });

  /** Speed and direction are not recoverable from the page; say so. */
  it('reports that motion parameters are defaults', () => {
    const r = reconstructTickers(cheerio.load(ticker()));
    expect(r.warnings.join(' ')).toMatch(/speed or direction/i);
  });

  it('does nothing when there is no ticker', () => {
    const r = reconstructTickers(cheerio.load('<div>plain</div>'));
    expect(r.tickers).toBe(0);
    expect(r.css).toBe('');
  });
});

describe('ticker and reveal interaction', () => {
  /**
   * Ordering bug guard: the ticker track is hidden inline too. If the reveal
   * pass claims it first, the ticker becomes visible but never moves.
   */
  it('leaves the ticker track to the ticker pass', () => {
    const $ = cheerio.load(
      '<ul style="display:flex;gap:20px;opacity:0"><li class="ticker-item">a</li></ul>',
    );
    reconstructTickers($);
    const reveal = extractScrollReveals($);
    expect($('ul').attr(REVEAL_ATTR)).toBeUndefined();
    expect(reveal.elements).toBe(0);
  });
});

describe('shim', () => {
  it('sets the gate class synchronously and does nothing else', () => {
    expect(HEAD_SHIM).toContain('uf-js');
    expect(HEAD_SHIM.length).toBeLessThan(120);
  });

  it('falls back to revealing everything without IntersectionObserver', () => {
    expect(BODY_SHIM).toContain('IntersectionObserver');
    expect(BODY_SHIM).toContain('revealAll');
  });

  it('stays small enough to inline', () => {
    expect(Buffer.byteLength(HEAD_SHIM + BODY_SHIM, 'utf8')).toBeLessThan(4096);
  });
});
