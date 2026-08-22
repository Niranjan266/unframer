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

      it('gets smaller', () => {
        expect(out.report.bytesAfter).toBeLessThan(out.report.bytesBefore);
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
