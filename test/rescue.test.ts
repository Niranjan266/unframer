/**
 * Tests for the runtime content rescue.
 *
 * The shim runs in a browser, so what is checked here is its shape and — more
 * importantly — the guards that stop it doing harm. Revealing a modal, a
 * tooltip or an inactive carousel slide would be a worse defect than the
 * invisible text it exists to fix, so those exclusions are the part most worth
 * pinning down.
 */

import { describe, it, expect } from 'vitest';
import * as cheerio from 'cheerio';
import { RESCUE_SCRIPT, RESCUE_CSS, RESCUE_CLASS, RESCUE_FLAG, rescueBytes } from '../src/rescue.js';
import { extract } from '../src/extract.js';

const PLAIN_PAGE =
  '<!doctype html><html lang="en"><head><title>Plain</title></head>' +
  '<body><h1>Hello</h1><p style="opacity:0">Hidden by the site</p></body></html>';

describe('rescue shim', () => {
  /** Doing nothing when the site works is the governing rule. */
  it('waits for the page to settle before deciding a reveal failed', () => {
    expect(RESCUE_SCRIPT).toContain('GRACE');
    expect(RESCUE_SCRIPT).toMatch(/addEventListener\('load'|readyState === 'complete'/);
  });

  it('leaves anything still being animated alone', () => {
    expect(RESCUE_SCRIPT).toContain('getAnimations');
  });

  /** Revealing these would be worse than the bug being fixed. */
  it('skips content that is hidden on purpose', () => {
    for (const marker of [
      'aria-hidden="true"',
      'role="dialog"',
      'role="tooltip"',
      '.modal',
      '.tooltip',
      '.sr-only',
      '.swiper-slide',
      '.carousel-item',
    ]) {
      expect(RESCUE_SCRIPT, `missing guard for ${marker}`).toContain(marker);
    }
  });

  it('ignores elements with no content and no size', () => {
    expect(RESCUE_SCRIPT).toContain('getBoundingClientRect');
    expect(RESCUE_SCRIPT).toContain('contentful');
  });

  /** A transparent, click-through layer is a scroll trigger, not content. */
  it('ignores pointer-events:none overlays', () => {
    expect(RESCUE_SCRIPT).toContain('pointerEvents');
  });

  it('reveals only the outermost hidden element', () => {
    // Revealing parent and child separately produces a visible double fade.
    expect(RESCUE_SCRIPT).toContain('outermost');
  });

  it('reveals on approach, with a fallback for what never intersects', () => {
    expect(RESCUE_SCRIPT).toContain('IntersectionObserver');
    expect(RESCUE_SCRIPT).toContain('setTimeout');
  });

  it('honours reduced motion', () => {
    expect(RESCUE_SCRIPT).toContain('prefers-reduced-motion');
    expect(RESCUE_CSS).toContain('prefers-reduced-motion');
  });

  it('cannot run twice', () => {
    expect(RESCUE_SCRIPT).toContain(RESCUE_FLAG);
  });

  it('clears a leftover transform, so nothing is revealed but displaced', () => {
    expect(RESCUE_SCRIPT).toContain("'transform', 'none'");
  });

  it('stays small enough to inline', () => {
    expect(rescueBytes()).toBeLessThan(8192);
  });
});

describe('generic extraction', () => {
  it('refuses a non-Framer page unless asked', () => {
    expect(() => extract(PLAIN_PAGE)).toThrow(/does not look like a published Framer site/);
  });

  it('takes the generic path when allowed', () => {
    const { report } = extract(PLAIN_PAGE, { allowNonFramer: true });
    expect(report.platform).toBe('generic');
    expect(report.isFramerSite).toBe(false);
  });

  it('includes the rescue shim on a generic page', () => {
    const { html, report } = extract(PLAIN_PAGE, { allowNonFramer: true });
    const $ = cheerio.load(html);
    expect($('script[data-unframer="rescue"]')).toHaveLength(1);
    expect($('style[data-unframer="rescue"]')).toHaveLength(1);
    expect(report.shimBytes).toBeGreaterThan(0);
    expect(html).toContain(RESCUE_CLASS);
  });

  it('can be turned off', () => {
    const { html } = extract(PLAIN_PAGE, { allowNonFramer: true, interactions: false });
    expect(cheerio.load(html)('script[data-unframer="rescue"]')).toHaveLength(0);
  });

  /** The Framer path has its own reveal handling; two systems would collide. */
  it('does not add the rescue shim to a Framer page', () => {
    const framerish =
      '<!doctype html><html lang="en"><head><meta name="generator" content="Framer abc">' +
      '<title>F</title><style data-framer-css-ssr-minified>a{color:red}</style></head>' +
      '<body><div id="main"><div data-framer-name="x">hi</div></div></body></html>';
    const { html, report } = extract(framerish, { allowNonFramer: true });
    expect(report.platform).toBe('framer');
    expect(cheerio.load(html)('script[data-unframer="rescue"]')).toHaveLength(0);
  });

  it('still strips trackers on a generic page', () => {
    const withTracker =
      '<!doctype html><html lang="en"><head><title>t</title>' +
      '<script src="https://www.googletagmanager.com/gtag/js?id=G-X"></script></head>' +
      '<body><p>hi</p></body></html>';
    const { html } = extract(withTracker, { allowNonFramer: true });
    expect(html).not.toContain('googletagmanager.com');
  });
});
