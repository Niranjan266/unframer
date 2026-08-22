/**
 * End-to-end tests against a committed fixture.
 *
 * The other integration tests run on captured copies of real Framer sites,
 * which are third-party content and therefore gitignored — so on a fresh clone
 * or in CI they skip, and coverage silently collapses to unit tests.
 *
 * This fixture is hand-authored to the same shape, so it ships with the repo
 * and CI exercises the whole pipeline for real. Because we control it exactly,
 * the assertions here can be precise numbers rather than "greater than zero".
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { extract } from '../src/extract.js';
import { APPEAR_ATTR } from '../src/appear.js';
import { REVEAL_ATTR } from '../src/reveal.js';
import { TICKER_ATTR } from '../src/ticker.js';
import { validateAgainstBaseline } from '../src/validate-html.js';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'synthetic',
  'framer-like.html',
);

describe('synthetic Framer page', () => {
  let source: string;
  let out: ReturnType<typeof extract>;
  let $: cheerio.CheerioAPI;

  beforeAll(() => {
    source = readFileSync(FIXTURE, 'utf8');
    out = extract(source);
    $ = cheerio.load(out.html);
  });

  it('detects the build hash', () => {
    expect(out.report.isFramerSite).toBe(true);
    expect(out.report.framerBuild).toBe('f1x7ure');
  });

  describe('stripping', () => {
    it('removes Framer analytics and the runtime', () => {
      expect($('script[src*="events.framer.com"]')).toHaveLength(0);
      expect($('script[data-framer-bundle]')).toHaveLength(0);
      expect($('link[rel="modulepreload"]')).toHaveLength(0);
    });

    it('removes third-party analytics, including the inline bootstrap', () => {
      expect(out.html).not.toContain('googletagmanager.com');
      expect(out.html).not.toContain('dataLayer.push');
    });

    it('removes the watermark and its CSS', () => {
      expect($('#__framer-badge-container')).toHaveLength(0);
      expect(out.html).not.toContain('#__framer-badge-container{');
      expect(out.html).not.toContain('.__framer-badge{');
    });

    it('removes the data islands once compiled', () => {
      expect($('script[type="framer/appear"]')).toHaveLength(0);
      expect($('script[type="framer/breakpoints"]')).toHaveLength(0);
    });

    it('leaves no script pointing at the Framer CDN', () => {
      const srcs = $('script[src]').map((_, el) => $(el).attr('src') ?? '').get();
      expect(srcs.filter((s) => s.includes('framerusercontent'))).toHaveLength(0);
    });

    it('keeps the SVG defs that <use> references', () => {
      expect($('#svg-templates')).toHaveLength(1);
      expect($('#synth-icon')).toHaveLength(1);
    });

    it('keeps the page CSS and fonts', () => {
      expect($('style[data-framer-css-ssr-minified]').length).toBeGreaterThan(0);
      expect($('style[data-framer-font-css]').length).toBeGreaterThan(0);
    });
  });

  describe('animations', () => {
    /**
     * `hero1` has only a default variant, so one unscoped rule. `card1` has
     * three explicit breakpoint variants plus a default covering the fourth,
     * so four scoped rules. Collapsing `card1` to its default is the bug that
     * leaves elements invisible on three of the four breakpoints.
     */
    it('emits one rule per breakpoint a variant covers', () => {
      expect(out.report.appearIds).toBe(2);
      expect(out.report.appearRulesEmitted).toBe(5);
    });

    it('scopes each breakpoint variant to its media query', () => {
      const css = $('style[data-unframer="appear"]').text();
      for (const [hash, query] of [
        ['72rtr7', '(min-width: 1440px)'],
        ['mz2m8j', '(min-width: 1200px) and (max-width: 1439px)'],
        ['19t9inl', '(min-width: 810px) and (max-width: 1199px)'],
        ['1p4axj2', '(max-width: 809px)'],
      ]) {
        expect(css).toContain(`@media ${query}`);
        expect(css).toContain(`:not(.hidden-${hash}) [${APPEAR_ATTR}="card1"]`);
      }
    });

    it('leaves the single-variant id unscoped', () => {
      const css = $('style[data-unframer="appear"]').text();
      expect(css).toContain(`[${APPEAR_ATTR}="hero1"]{animation:`);
    });

    it('converts a spring to a sampled linear() curve', () => {
      const css = $('style[data-unframer="appear"]').text();
      expect(css).toContain('linear(');
    });

    it('passes an explicit cubic-bezier through unchanged', () => {
      const css = $('style[data-unframer="appear"]').text();
      expect(css).toContain('cubic-bezier(0.44, 0, 0.16, 1)');
    });

    it('preserves the perspective/scale transform order', () => {
      const css = $('style[data-unframer="appear"]').text();
      expect(css).toContain('perspective(1200px) scale(0.8)');
    });
  });

  describe('interactions', () => {
    /** Three inline-hidden elements with no appear id; the blur shares no group. */
    it('annotates every hidden element that has no appear data', () => {
      expect(out.report.scrollReveals).toBe(3);
      expect(out.report.revealGroups).toBe(2);
      expect($(`[${REVEAL_ATTR}]`)).toHaveLength(3);
    });

    it('carries the blur into the from-state', () => {
      expect($('style[data-unframer="interactions"]').text()).toContain('filter:blur(10px)');
    });

    it('reconstructs the ticker and duplicates its items', () => {
      expect(out.report.tickers).toBe(1);
      expect($(`[${TICKER_ATTR}]`)).toHaveLength(1);
      expect($('li.ticker-item')).toHaveLength(6);
      expect($('li.ticker-item[aria-hidden="true"]')).toHaveLength(3);
    });

    it('offsets the ticker loop by half its gap', () => {
      expect($('style[data-unframer="interactions"]').text()).toContain('calc(-50% - 10px)');
    });

    it('ships the shim in two halves', () => {
      expect($('script[data-unframer="shim-head"]')).toHaveLength(1);
      expect($('script[data-unframer="shim"]')).toHaveLength(1);
    });

    /** Without the gate, a shim failure would leave the page blank. */
    it('gates every hidden rule behind .uf-js', () => {
      const css = $('style[data-unframer="interactions"]').text();
      for (const line of css.split('\n')) {
        if (/\{[^}]*opacity:0/.test(line) && !line.includes('prefers-reduced-motion')) {
          expect(line).toContain('.uf-js');
        }
      }
    });

    /** Framer uses partial opacity as design, not as a hidden state. */
    it('leaves a deliberately translucent element alone', () => {
      expect($('.framer-synth-dim').attr(REVEAL_ATTR)).toBeUndefined();
    });
  });

  describe('output integrity', () => {
    /** The regression that shipped once: nothing may stay hidden inline. */
    it('leaves no element hidden by an inline style', () => {
      const hidden = $('[style]')
        .filter((_, el) => {
          const m = ($(el).attr('style') ?? '').match(/(?:^|;)\s*opacity\s*:\s*([\d.]+)/);
          return m ? Number.parseFloat(m[1]) < 0.5 : false;
        })
        .get();
      expect(hidden).toHaveLength(0);
    });

    it('flags the form rather than letting it swallow submissions', () => {
      // auditForms runs in the multi-page path; the action must at least survive.
      expect($('form').attr('action')).toBe('https://api.framer.com/forms/submit');
    });

    it('inventories every asset, social images included', () => {
      const urls = out.report.assets.map((a) => a.url);
      expect(urls).toContain('https://framerusercontent.com/images/ogcard.png');
      expect(urls).toContain('https://framerusercontent.com/images/photo.png?scale-down-to=1024');
      expect(urls).toContain('https://fonts.gstatic.com/s/synthsans/v1/abc123.woff2');
      expect(urls.some((u) => u.includes('bg.jpg'))).toBe(true);
    });

    it('introduces no markup errors', async () => {
      const { introduced } = await validateAgainstBaseline(out.html, source);
      expect(introduced.map((i) => `${i.rule}: ${i.message}`)).toHaveLength(0);
    });
  });
});
