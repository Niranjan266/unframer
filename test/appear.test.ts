/**
 * Tests for the appear compiler — the component where a bug renders the whole
 * page invisible, so it gets the most coverage.
 */

import { describe, it, expect } from 'vitest';
import * as cheerio from 'cheerio';
import {
  compileAppearCss,
  buildTransform,
  parseAppearSpec,
  neutralizeInlineInitialState,
  APPEAR_ATTR,
} from '../src/appear.js';
import { resolveBreakpoints, breakpointsForDefault } from '../src/breakpoints.js';
import { springToLinearEasing, toCssEasing } from '../src/easing.js';
import type { AppearSpec, Breakpoint } from '../src/types.js';

const BREAKPOINTS: Breakpoint[] = [
  { hash: '72rtr7', mediaQuery: '(min-width: 1440px)' },
  { hash: 'mz2m8j', mediaQuery: '(min-width: 1200px) and (max-width: 1439px)' },
  { hash: '19t9inl', mediaQuery: '(min-width: 810px) and (max-width: 1199px)' },
  { hash: '1p4axj2', mediaQuery: '(max-width: 809px)' },
];

describe('buildTransform', () => {
  it('returns none for an empty state', () => {
    expect(buildTransform({})).toBe('none');
    expect(buildTransform(undefined)).toBe('none');
  });

  it('emits translate for x/y', () => {
    expect(buildTransform({ y: -20 })).toBe('translateY(-20px)');
    expect(buildTransform({ x: 10, y: 5 })).toBe('translateX(10px) translateY(5px)');
  });

  it('puts perspective first, matching Motion output', () => {
    expect(buildTransform({ transformPerspective: 1200, scale: 0.8 })).toBe(
      'perspective(1200px) scale(0.8)',
    );
  });

  it('omits identity values so transforms stay minimal', () => {
    expect(buildTransform({ scale: 1, rotate: 0, x: 0 })).toBe('none');
  });
});

describe('easing', () => {
  it('samples springs into a CSS linear() curve', () => {
    const e = springToLinearEasing(0);
    expect(e.startsWith('linear(')).toBe(true);
    expect(e.endsWith(')')).toBe(true);
    // Must start at 0 and finish exactly at 1, or the element never fully settles.
    const nums = e.slice(7, -1).split(',').map((s) => parseFloat(s));
    expect(nums[0]).toBe(0);
    expect(nums[nums.length - 1]).toBe(1);
  });

  it('is monotonic when critically damped (bounce 0)', () => {
    const nums = springToLinearEasing(0)
      .slice(7, -1)
      .split(',')
      .map((s) => parseFloat(s));
    for (let i = 1; i < nums.length; i++) {
      expect(nums[i]).toBeGreaterThanOrEqual(nums[i - 1]);
    }
  });

  it('overshoots past 1 when bounce is high', () => {
    const nums = springToLinearEasing(0.7)
      .slice(7, -1)
      .split(',')
      .map((s) => parseFloat(s));
    expect(Math.max(...nums)).toBeGreaterThan(1);
  });

  it('passes through explicit cubic-bezier arrays', () => {
    expect(toCssEasing({ ease: [0.1, 0.2, 0.3, 0.4] })).toBe(
      'cubic-bezier(0.1, 0.2, 0.3, 0.4)',
    );
  });
});

describe('breakpointsForDefault', () => {
  it('gives default the breakpoints no explicit variant claimed', () => {
    const rest = breakpointsForDefault(['mz2m8j', '19t9inl', '1p4axj2'], BREAKPOINTS);
    expect(rest.map((b) => b.hash)).toEqual(['72rtr7']);
  });

  it('gives default everything when there are no explicit variants', () => {
    expect(breakpointsForDefault([], BREAKPOINTS)).toHaveLength(4);
  });
});

describe('compileAppearCss', () => {
  const simple: AppearSpec = {
    abc123: {
      default: {
        initial: { opacity: 0.001, y: -20 },
        animate: { opacity: 1, y: 0, transition: { type: 'spring', duration: 0.6, delay: 1 } },
      },
    },
  };

  it('emits an unscoped rule when there is only a default variant', () => {
    const { css, rulesEmitted } = compileAppearCss(simple, BREAKPOINTS);
    expect(rulesEmitted).toBe(1);
    expect(css).toContain(`[${APPEAR_ATTR}="abc123"]`);
    expect(css).not.toContain('@media (min-width: 1440px)');
    expect(css).toContain('@keyframes fx-abc123-default');
  });

  it('carries duration and delay through to the animation shorthand', () => {
    const { css } = compileAppearCss(simple, BREAKPOINTS);
    expect(css).toMatch(/animation:fx-abc123-default 0\.6s .* 1s both/);
  });

  it('animates from the initial opacity to fully visible', () => {
    const { css } = compileAppearCss(simple, BREAKPOINTS);
    expect(css).toContain('from{opacity:0.001;transform:translateY(-20px)}');
    expect(css).toContain('to{opacity:1;transform:none}');
  });

  /**
   * The regression that motivated this whole module: collapsing per-breakpoint
   * variants to `default` leaves elements invisible on every other breakpoint.
   */
  it('scopes every breakpoint variant, including the one default covers', () => {
    const responsive: AppearSpec = {
      xyz789: {
        default: { initial: { opacity: 0.001 }, animate: { opacity: 1 } },
        mz2m8j: { initial: { opacity: 0.001, y: 10 }, animate: { opacity: 1, y: 0 } },
        '19t9inl': { initial: { opacity: 0.001, y: 20 }, animate: { opacity: 1, y: 0 } },
        '1p4axj2': { initial: { opacity: 0.001, y: 30 }, animate: { opacity: 1, y: 0 } },
      },
    };

    const { css, rulesEmitted } = compileAppearCss(responsive, BREAKPOINTS);

    // Three explicit variants plus default covering the remaining breakpoint.
    expect(rulesEmitted).toBe(4);

    for (const bp of BREAKPOINTS) {
      expect(css).toContain(`@media ${bp.mediaQuery}`);
      expect(css).toContain(`:not(.hidden-${bp.hash}) [${APPEAR_ATTR}="xyz789"]`);
    }
  });

  it('still emits a rule when breakpoint data is missing entirely', () => {
    const responsive: AppearSpec = {
      q1: {
        default: { initial: { opacity: 0.001 }, animate: { opacity: 1 } },
        unknownhash: { initial: { opacity: 0.001 }, animate: { opacity: 1 } },
      },
    };
    const { css, rulesEmitted, warnings } = compileAppearCss(responsive, []);
    expect(rulesEmitted).toBeGreaterThan(0);
    expect(css).toContain(`[${APPEAR_ATTR}="q1"]`);
    expect(warnings.join(' ')).toContain('unknown breakpoint hash');
  });

  it('includes a reduced-motion escape hatch', () => {
    const { css } = compileAppearCss(simple, BREAKPOINTS, true);
    expect(css).toContain('prefers-reduced-motion:reduce');
    expect(css).toContain('opacity:1!important');
  });
});

describe('neutralizeInlineInitialState', () => {
  it('removes the hidden state but keeps layout properties', () => {
    const $ = cheerio.load(
      `<div ${APPEAR_ATTR}="a" style="outline:none;display:flex;opacity:0.001;flex-shrink:0;will-change:transform;transform:translateY(20px)"></div>`,
    );
    const n = neutralizeInlineInitialState($);
    expect(n).toBe(1);

    const style = $(`[${APPEAR_ATTR}="a"]`).attr('style') ?? '';
    expect(style).not.toContain('opacity');
    expect(style).not.toContain('transform');
    expect(style).toContain('display:flex');
    expect(style).toContain('flex-shrink:0');
  });

  it('drops the style attribute entirely when nothing survives', () => {
    const $ = cheerio.load(
      `<div ${APPEAR_ATTR}="b" style="opacity:0.001;transform:translateY(-20px)"></div>`,
    );
    neutralizeInlineInitialState($);
    expect($(`[${APPEAR_ATTR}="b"]`).attr('style')).toBeUndefined();
  });

  it('leaves untouched elements alone', () => {
    const $ = cheerio.load(`<div ${APPEAR_ATTR}="c" style="display:grid"></div>`);
    expect(neutralizeInlineInitialState($)).toBe(0);
    expect($(`[${APPEAR_ATTR}="c"]`).attr('style')).toBe('display:grid');
  });
});

describe('parsing', () => {
  it('returns an empty spec when the island is absent', () => {
    const $ = cheerio.load('<html><head></head><body></body></html>');
    expect(parseAppearSpec($)).toEqual({});
    expect(resolveBreakpoints($)).toEqual([]);
  });

  it('survives malformed JSON without throwing', () => {
    const $ = cheerio.load(
      '<script type="framer/appear" id="__framer__appearAnimationsContent">{not json</script>',
    );
    expect(parseAppearSpec($)).toEqual({});
  });
});
