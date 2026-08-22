import { describe, it, expect } from 'vitest';
import * as cheerio from 'cheerio';
import { localizeAssets, localizeMetaImages, rewriteCssUrls, auditRemoteStylesheets } from '../src/localize.js';
import { localNameFor } from '../src/download.js';

const CDN = 'https://framerusercontent.com';

describe('localNameFor', () => {
  it('keeps the original stem so output stays debuggable', () => {
    const name = localNameFor(`${CDN}/images/hero.png`, 'image');
    expect(name).toMatch(/^assets\/images\/hero-[0-9a-f]{8}\.png$/);
  });

  it('files each kind in its own directory', () => {
    expect(localNameFor(`${CDN}/x.woff2`, 'font')).toContain('assets/fonts/');
    expect(localNameFor(`${CDN}/x.mp4`, 'video')).toContain('assets/media/');
    expect(localNameFor(`${CDN}/x.bin`, 'other')).toContain('assets/files/');
  });

  /**
   * Framer's responsive variants differ only by query string. Hashing the bare
   * pathname would collapse them into one file and silently lose resolutions.
   */
  it('gives each srcset variant a distinct name', () => {
    const a = localNameFor(`${CDN}/images/hero.png?scale-down-to=512`, 'image');
    const b = localNameFor(`${CDN}/images/hero.png?scale-down-to=2048`, 'image');
    const c = localNameFor(`${CDN}/images/hero.png`, 'image');
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('is stable for the same URL', () => {
    const url = `${CDN}/images/hero.png?scale-down-to=512`;
    expect(localNameFor(url, 'image')).toBe(localNameFor(url, 'image'));
  });

  it('falls back to the content type when the URL has no extension', () => {
    expect(localNameFor(`${CDN}/images/abc`, 'image', 'image/webp')).toMatch(/\.webp$/);
  });

  it('sanitises characters that are unsafe in filenames', () => {
    const name = localNameFor(`${CDN}/images/a b:c*d.png`, 'image');
    expect(name).not.toMatch(/[ :*]/);
    expect(name).toMatch(/\.png$/);
  });
});

describe('localizeAssets', () => {
  const map = new Map([
    [`${CDN}/images/hero.png`, 'assets/images/hero-aaaaaaaa.png'],
    [`${CDN}/images/hero.png?scale-down-to=512`, 'assets/images/hero-bbbbbbbb.png'],
    [`${CDN}/images/hero.png?scale-down-to=1024`, 'assets/images/hero-cccccccc.png'],
    [`${CDN}/fonts/body.woff2`, 'assets/fonts/body-dddddddd.woff2'],
  ]);

  it('rewrites src to the local copy', () => {
    const $ = cheerio.load(`<img src="${CDN}/images/hero.png">`);
    const r = localizeAssets($, map, '/');
    expect($('img').attr('src')).toBe('assets/images/hero-aaaaaaaa.png');
    expect(r.rewritten).toBe(1);
  });

  /** Rewriting only `src` would leave the browser fetching the rest from the CDN. */
  it('rewrites every srcset candidate and keeps its descriptor', () => {
    const $ = cheerio.load(
      `<img srcset="${CDN}/images/hero.png?scale-down-to=512 512w, ${CDN}/images/hero.png?scale-down-to=1024 1024w">`,
    );
    localizeAssets($, map, '/');
    const srcset = $('img').attr('srcset') ?? '';
    expect(srcset).toBe(
      'assets/images/hero-bbbbbbbb.png 512w, assets/images/hero-cccccccc.png 1024w',
    );
    expect(srcset).not.toContain('framerusercontent');
  });

  /** Root-relative paths would break file:// use and subdirectory hosting. */
  it('makes paths relative to the page, not the site root', () => {
    const $ = cheerio.load(`<img src="${CDN}/images/hero.png">`);
    localizeAssets($, map, '/blog/post');
    expect($('img').attr('src')).toBe('../../assets/images/hero-aaaaaaaa.png');
  });

  it('rewrites @font-face inside style blocks', () => {
    const $ = cheerio.load(
      `<style>@font-face{font-family:X;src:url(${CDN}/fonts/body.woff2) format("woff2")}</style>`,
    );
    localizeAssets($, map, '/');
    const css = $('style').html() ?? '';
    expect(css).toContain('assets/fonts/body-dddddddd.woff2');
    expect(css).not.toContain('framerusercontent');
  });

  it('rewrites url() inside inline style attributes', () => {
    const $ = cheerio.load(`<div style="background-image:url(${CDN}/images/hero.png)"></div>`);
    localizeAssets($, map, '/about');
    expect($('div').attr('style')).toContain('../assets/images/hero-aaaaaaaa.png');
  });

  /** A hotlinked asset still renders; a rewritten-but-missing one does not. */
  it('leaves unmapped assets pointing at the CDN and counts them', () => {
    const $ = cheerio.load(`<img src="${CDN}/images/unknown.png">`);
    const r = localizeAssets($, map, '/');
    expect($('img').attr('src')).toBe(`${CDN}/images/unknown.png`);
    expect(r.leftRemote).toBe(1);
    expect(r.rewritten).toBe(0);
  });

  it('never touches data URIs', () => {
    const data = 'data:image/svg+xml;utf8,<svg></svg>';
    const $ = cheerio.load(`<img src="${data}">`);
    localizeAssets($, map, '/');
    expect($('img').attr('src')).toBe(data);
  });
});

describe('localizeMetaImages', () => {
  const map = new Map([[`${CDN}/images/og.jpg`, 'assets/images/og-eeeeeeee.jpg']]);
  const html = `<meta property="og:image" content="${CDN}/images/og.jpg"><meta name="twitter:image" content="${CDN}/images/og.jpg">`;

  /** Crawlers resolve these from outside the page, so relative paths cannot work. */
  it('rewrites to an absolute URL on the new domain', () => {
    const $ = cheerio.load(html);
    const r = localizeMetaImages($, map, 'https://example.com');
    expect($('meta[property="og:image"]').attr('content')).toBe(
      'https://example.com/assets/images/og-eeeeeeee.jpg',
    );
    expect($('meta[name="twitter:image"]').attr('content')).toBe(
      'https://example.com/assets/images/og-eeeeeeee.jpg',
    );
    expect(r.rewritten).toBe(2);
  });

  it('tolerates a trailing slash on the base URL', () => {
    const $ = cheerio.load(html);
    localizeMetaImages($, map, 'https://example.com/');
    expect($('meta[property="og:image"]').attr('content')).toBe(
      'https://example.com/assets/images/og-eeeeeeee.jpg',
    );
  });

  /** A working preview pointing at Framer beats one no crawler can resolve. */
  it('leaves them remote and reports when no base URL is known', () => {
    const $ = cheerio.load(html);
    const r = localizeMetaImages($, map, undefined);
    expect($('meta[property="og:image"]').attr('content')).toBe(`${CDN}/images/og.jpg`);
    expect(r.needsBaseUrl).toBe(2);
    expect(r.rewritten).toBe(0);
  });
});

describe('rewriteCssUrls', () => {
  const map = new Map([['https://cdn.test/a.woff2', 'assets/fonts/a-1234.woff2']]);

  it('preserves the original quoting style', () => {
    expect(rewriteCssUrls('src:url("https://cdn.test/a.woff2")', map, '')).toBe(
      'src:url("assets/fonts/a-1234.woff2")',
    );
    expect(rewriteCssUrls('src:url(https://cdn.test/a.woff2)', map, '')).toBe(
      'src:url(assets/fonts/a-1234.woff2)',
    );
  });

  it('applies the page depth prefix', () => {
    expect(rewriteCssUrls('url(https://cdn.test/a.woff2)', map, '../')).toBe(
      'url(../assets/fonts/a-1234.woff2)',
    );
  });

  it('leaves data URIs alone', () => {
    const css = 'url(data:image/png;base64,AAA)';
    expect(rewriteCssUrls(css, map, '')).toBe(css);
  });
});

describe('auditRemoteStylesheets', () => {
  it('flags a page that still loads CSS from a remote host', () => {
    const $ = cheerio.load('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=X">');
    expect(auditRemoteStylesheets($).join(' ')).toContain('not fully self-contained');
  });

  it('says nothing when every stylesheet is local', () => {
    const $ = cheerio.load('<link rel="stylesheet" href="assets/site.css">');
    expect(auditRemoteStylesheets($)).toEqual([]);
  });
});
