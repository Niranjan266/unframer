/**
 * Tests for transform splitting.
 *
 * This guards a bug that reached a user: a page where 59 elements were centred
 * with `translate(-50%, -50%)` and animated with `translateY(40px)` in the same
 * declaration. Treating the whole thing as animation state and settling it to
 * `transform: none` shifted every one of them right by half its own width, and
 * the page looked comprehensively misaligned — while content and pixel checks
 * still passed, because nothing measured position.
 */

import { describe, it, expect } from 'vitest';
import * as cheerio from 'cheerio';
import {
  splitTransform,
  composeTransform,
  settledTransform,
  BASE_TRANSFORM_VAR,
} from '../src/transform.js';
import { extractScrollReveals, REVEAL_ATTR } from '../src/reveal.js';
import { neutralizeInlineInitialState, APPEAR_ATTR } from '../src/appear.js';

describe('splitTransform', () => {
  it('treats a percentage translate as layout', () => {
    expect(splitTransform('translate(-50%, -50%)')).toEqual({
      layout: 'translate(-50%, -50%)',
      animation: '',
    });
  });

  it('treats a pixel translate as animation', () => {
    expect(splitTransform('translateY(40px)')).toEqual({
      layout: '',
      animation: 'translateY(40px)',
    });
  });

  /** The exact shape that broke a real export. */
  it('separates centring from motion in a mixed declaration', () => {
    expect(splitTransform('translate(-50%, -50%) translateY(40px)')).toEqual({
      layout: 'translate(-50%, -50%)',
      animation: 'translateY(40px)',
    });
  });

  it('classifies single-axis percentage translates as layout', () => {
    expect(splitTransform('translateX(-50%)').layout).toBe('translateX(-50%)');
    expect(splitTransform('translateY(-50%)').layout).toBe('translateY(-50%)');
  });

  it('keeps scale, rotate, skew and perspective as animation', () => {
    const r = splitTransform('perspective(1200px) scale(0.8) rotate(-7deg) skewX(2deg)');
    expect(r.layout).toBe('');
    expect(r.animation).toBe('perspective(1200px) scale(0.8) rotate(-7deg) skewX(2deg)');
  });

  it('handles absent, empty and none', () => {
    for (const v of [undefined, '', '   ', 'none']) {
      expect(splitTransform(v)).toEqual({ layout: '', animation: '' });
    }
  });

  it('preserves order within each half', () => {
    const r = splitTransform('translateX(-50%) scale(0.5) translateY(-50%) rotate(4deg)');
    expect(r.layout).toBe('translateX(-50%) translateY(-50%)');
    expect(r.animation).toBe('scale(0.5) rotate(4deg)');
  });
});

describe('composeTransform', () => {
  it('composes animation on top of the layout variable', () => {
    expect(composeTransform('translateY(40px)')).toBe(`var(${BASE_TRANSFORM_VAR},) translateY(40px)`);
  });

  /** An empty fallback keeps the declaration valid when there is no layout part. */
  it('falls back to none when there is no animation', () => {
    expect(composeTransform('')).toBe(`var(${BASE_TRANSFORM_VAR}, none)`);
  });

  it('never settles to a bare none', () => {
    expect(settledTransform()).toContain(BASE_TRANSFORM_VAR);
    expect(settledTransform()).not.toBe('none');
  });
});

describe('reveal preserves layout transforms', () => {
  it('moves centring into the custom property and animates only the offset', () => {
    const $ = cheerio.load(
      '<div style="will-change:transform;opacity:0;transform:translate(-50%, -50%) translateY(40px)">Hi</div>',
    );
    const result = extractScrollReveals($);

    const style = $('div').attr('style') ?? '';
    expect(style).toContain(`${BASE_TRANSFORM_VAR}:translate(-50%, -50%)`);
    expect(style).not.toContain('translateY(40px)');

    expect(result.css).toContain(`transform:var(${BASE_TRANSFORM_VAR},) translateY(40px)`);
    expect(result.css).toContain(`transform:var(${BASE_TRANSFORM_VAR}, none)`);
  });

  /** The settled rule resolving to `none` is the defect itself. */
  it('never emits a settled transform of none', () => {
    const $ = cheerio.load('<div style="opacity:0;transform:translate(-50%,-50%) translateY(40px)">Hi</div>');
    const { css } = extractScrollReveals($);
    expect(css).not.toContain('transform:none');
  });

  it('adds no custom property when there is nothing to preserve', () => {
    const $ = cheerio.load('<div style="opacity:0;transform:translateY(50px)">Hi</div>');
    extractScrollReveals($);
    expect($('div').attr('style') ?? '').not.toContain(BASE_TRANSFORM_VAR);
  });

  it('groups by the animated half, so centring does not fragment groups', () => {
    const $ = cheerio.load(
      '<div style="opacity:0;transform:translate(-50%,-50%) translateY(40px)">a</div>' +
        '<div style="opacity:0;transform:translateY(40px)">b</div>',
    );
    const result = extractScrollReveals($);
    expect(result.elements).toBe(2);
    expect(result.groups).toBe(1);
    expect($('div').eq(0).attr(REVEAL_ATTR)).toBe($('div').eq(1).attr(REVEAL_ATTR));
  });
});

describe('appear preserves layout transforms', () => {
  it('keeps centring when neutralising the inline initial state', () => {
    const $ = cheerio.load(
      `<div ${APPEAR_ATTR}="x" style="opacity:0.001;will-change:transform;transform:translate(-50%, -50%) translateY(-20px)"></div>`,
    );
    neutralizeInlineInitialState($);

    const style = $('div').attr('style') ?? '';
    expect(style).toContain(`${BASE_TRANSFORM_VAR}:translate(-50%, -50%)`);
    expect(style).not.toContain('translateY(-20px)');
    expect(style).not.toContain('opacity');
  });

  it('leaves a purely animated transform behind entirely', () => {
    const $ = cheerio.load(
      `<div ${APPEAR_ATTR}="y" style="opacity:0.001;transform:translateY(-20px)"></div>`,
    );
    neutralizeInlineInitialState($);
    expect($('div').attr('style')).toBeUndefined();
  });
});
