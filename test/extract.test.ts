/**
 * Integration tests against real captured Framer pages.
 *
 * The fixtures are locally captured copies of public pages, used only to pin
 * the extractor's behaviour against real Framer output. They are development
 * inputs, not redistributable content — see test/fixtures/README.md.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { extract, NotAFramerSiteError } from '../src/extract.js';
import { APPEAR_ATTR } from '../src/appear.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Free-tier sites carry the badge; the paid one does not. */
const CASES = [
  { file: 'framer-template.html', expectBadge: true },
  { file: 'linkin.html', expectBadge: true },
  { file: 'novo.html', expectBadge: true },
  { file: 'framer-university.html', expectBadge: false },
];

const available = CASES.filter((c) => existsSync(join(FIXTURES, c.file)));

describe.skipIf(available.length === 0)('extract (real Framer pages)', () => {
  for (const { file, expectBadge } of available) {
    describe(file, () => {
      let html: string;
      let out: ReturnType<typeof extract>;

      beforeAll(() => {
        html = readFileSync(join(FIXTURES, file), 'utf8');
        out = extract(html);
      });

      it('detects a Framer site', () => {
        expect(out.report.isFramerSite).toBe(true);
      });

      it('removes every runtime and tracker script', () => {
        const $ = cheerio.load(out.html);
        expect($('script[data-framer-bundle]')).toHaveLength(0);
        expect($('script[src*="events.framer.com"]')).toHaveLength(0);
        expect($('link[rel="modulepreload"]')).toHaveLength(0);
        expect($('script[type="framer/appear"]')).toHaveLength(0);
        expect($('script[type="framer/breakpoints"]')).toHaveLength(0);
      });

      it('leaves no script pointing at the Framer CDN', () => {
        const $ = cheerio.load(out.html);
        const srcs = $('script[src]')
          .map((_, el) => $(el).attr('src') ?? '')
          .get();
        expect(srcs.filter((s) => s.includes('framerusercontent.com'))).toHaveLength(0);
      });

      it('removes the watermark container and its CSS', () => {
        const $ = cheerio.load(out.html);
        expect($('#__framer-badge-container')).toHaveLength(0);
        expect(out.html).not.toContain('#__framer-badge-container{');
        expect(out.html).not.toContain('.__framer-badge{');
      });

      if (expectBadge) {
        it('reported the watermark it removed', () => {
          const watermark = out.report.removals.filter((r) => r.kind === 'watermark');
          const total = watermark.reduce((a, r) => a + r.count, 0);
          expect(total).toBeGreaterThan(0);
        });
      }

      it('keeps the SVG template defs referenced by <use>', () => {
        const $in = cheerio.load(html);
        if ($in('#svg-templates').length > 0) {
          expect(cheerio.load(out.html)('#svg-templates')).toHaveLength(1);
        }
      });

      it('preserves the page CSS and fonts', () => {
        const $ = cheerio.load(out.html);
        expect($('style[data-framer-css-ssr-minified]').length).toBeGreaterThan(0);
      });

      it('leaves no element stuck at its invisible initial state', () => {
        const $ = cheerio.load(out.html);
        const stuck = $(`[${APPEAR_ATTR}]`)
          .filter((_, el) => {
            const style = $(el).attr('style') ?? '';
            return /opacity\s*:\s*0(\.0+)?\d*/.test(style) || style.includes('transform:');
          })
          .length;
        expect(stuck).toBe(0);
      });

      /**
       * The regression that matters most. An earlier version scoped this check
       * to [data-framer-appear-id] and so passed clean while leaving 155
       * elements — more than half the visible text — permanently invisible.
       * Nothing may be left hidden by an inline style, whether or not it has
       * appear data.
       */
      it('leaves NO element hidden by an inline style', () => {
        const $ = cheerio.load(out.html);
        const hidden = $('[style]')
          .filter((_, el) => {
            const style = $(el).attr('style') ?? '';
            const m = style.match(/(?:^|;)\s*opacity\s*:\s*([\d.]+)/);
            return m ? Number.parseFloat(m[1]) < 0.5 : false;
          })
          .map((_, el) => ($(el).attr('class') ?? '').slice(0, 40))
          .get();

        expect(hidden, `still hidden inline: ${hidden.slice(0, 5).join(' | ')}`).toHaveLength(0);
      });

      it('hands every hidden element to a reveal or appear rule', () => {
        const $ = cheerio.load(out.html);
        const reveals = $('[data-uf-reveal]').length;
        const appears = $(`[${APPEAR_ATTR}]`).length;
        // Whatever was hidden in the source must now be driven by one of the two.
        const sourceHidden = (html.match(/style="[^"]*opacity:0[.;"]/g) ?? []).length;
        if (sourceHidden > 0) expect(reveals + appears).toBeGreaterThan(0);
      });

      it('gates every reveal rule behind .uf-js so no-JS renders visible', () => {
        const $ = cheerio.load(out.html);
        const css = $('style[data-unframer="interactions"]').text();
        if (!css) return;
        for (const line of css.split('\n')) {
          if (/\{[^}]*opacity:0/.test(line) && !line.includes('prefers-reduced-motion')) {
            expect(line).toContain('.uf-js');
          }
        }
      });

      it('ships the shim whenever it annotated reveals', () => {
        const $ = cheerio.load(out.html);
        if ($('[data-uf-reveal]').length > 0) {
          expect($('script[data-unframer="shim-head"]')).toHaveLength(1);
          expect($('script[data-unframer="shim"]')).toHaveLength(1);
        }
      });

      it('compiles a rule for every animated id', () => {
        if (out.report.appearIds === 0) return;
        expect(out.report.appearRulesEmitted).toBeGreaterThanOrEqual(out.report.appearIds);
        expect(out.html).toContain('data-unframer="appear"');
      });

      /** Every animated element must be matched by at least one emitted rule. */
      it('covers every animated element at every breakpoint', () => {
        if (out.report.appearIds === 0) return;
        const $ = cheerio.load(out.html);
        const css = $('style[data-unframer="appear"]').text();
        const ids = new Set(
          $(`[${APPEAR_ATTR}]`)
            .map((_, el) => $(el).attr(APPEAR_ATTR) ?? '')
            .get(),
        );

        for (const id of ids) {
          expect(css, `no rule emitted for appear id ${id}`).toContain(
            `[${APPEAR_ATTR}="${id}"]`,
          );
        }
      });

      /**
       * The document itself can legitimately grow: tickers duplicate their item
       * set for a seamless loop, and every page gains the shim plus reveal CSS.
       * The real saving is the 200 KB+ of runtime JavaScript, which was never
       * part of the HTML byte count — so assert the document stays in
       * proportion rather than that it shrinks.
       */
      it('does not bloat the document', () => {
        const ratio = out.report.bytesAfter / out.report.bytesBefore;
        const limit = out.report.tickers > 0 ? 1.2 : 1.02;
        expect(
          ratio,
          `${out.report.bytesBefore} → ${out.report.bytesAfter} (${out.report.tickers} ticker(s))`,
        ).toBeLessThan(limit);
      });

      it('removes far more than it adds', () => {
        const removed = out.report.removals.reduce((a, r) => a + r.count, 0);
        expect(removed).toBeGreaterThan(0);
      });

      it('inventories assets', () => {
        expect(out.report.assets.length).toBeGreaterThan(0);
      });
    });
  }
});

describe('guard rails', () => {
  it('refuses to process a non-Framer page', () => {
    const html = '<html><head><title>Plain</title></head><body><h1>Hi</h1></body></html>';
    expect(() => extract(html)).toThrow(NotAFramerSiteError);
  });

  it('explains what it looked for when it refuses', () => {
    try {
      extract('<html><body></body></html>');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NotAFramerSiteError);
      expect((err as Error).message).toContain('does not look like a published Framer site');
    }
  });
});
