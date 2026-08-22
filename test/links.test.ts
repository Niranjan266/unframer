import { describe, it, expect } from 'vitest';
import * as cheerio from 'cheerio';
import { relativeHref, relativePrefix, rewriteLinks, rewriteCanonical, auditForms } from '../src/links.js';

const ORIGIN = 'https://example.framer.website';

describe('relativePrefix', () => {
  it('climbs one level per path segment', () => {
    expect(relativePrefix('/')).toBe('');
    expect(relativePrefix('/about')).toBe('../');
    expect(relativePrefix('/blog/post')).toBe('../../');
  });
});

describe('relativeHref', () => {
  /**
   * Links name the file explicitly so the export works off the filesystem too,
   * where `file://` will not resolve a directory to its index document.
   */
  it('links between pages at the same depth', () => {
    expect(relativeHref('/', '/about')).toBe('about/index.html');
  });

  it('climbs back to the root from a nested page', () => {
    expect(relativeHref('/about', '/')).toBe('../index.html');
    expect(relativeHref('/blog/post', '/')).toBe('../../index.html');
  });

  it('links sideways between nested pages', () => {
    expect(relativeHref('/blog/post', '/about')).toBe('../../about/index.html');
  });

  it('preserves a query or fragment', () => {
    expect(relativeHref('/', '/about', '#team')).toBe('about/index.html#team');
  });
});

describe('rewriteLinks', () => {
  const exported = new Set(['/', '/about', '/blog/post']);

  function run(html: string, currentRoute = '/') {
    const $ = cheerio.load(html);
    const result = rewriteLinks($, { currentRoute, origin: ORIGIN, exportedRoutes: exported });
    return { $, result };
  }

  it('repoints internal links at exported files', () => {
    const { $, result } = run('<a href="/about">x</a>');
    expect($('a').attr('href')).toBe('about/index.html');
    expect(result.internalRewritten).toBe(1);
  });

  it('handles absolute same-origin links', () => {
    const { $ } = run(`<a href="${ORIGIN}/blog/post">x</a>`);
    expect($('a').attr('href')).toBe('blog/post/index.html');
  });

  it('computes the right depth from a nested page', () => {
    const { $ } = run('<a href="/about">x</a>', '/blog/post');
    expect($('a').attr('href')).toBe('../../about/index.html');
  });

  it('leaves external links untouched', () => {
    const { $ } = run('<a href="https://external.com/x">x</a>');
    expect($('a').attr('href')).toBe('https://external.com/x');
  });

  it('leaves anchors, mail and tel untouched', () => {
    const { $ } = run('<a href="#top">a</a><a href="mailto:x@y.com">b</a><a href="tel:+1">c</a>');
    const hrefs = $('a').map((_, el) => $(el).attr('href')).get();
    expect(hrefs).toEqual(['#top', 'mailto:x@y.com', 'tel:+1']);
  });

  /**
   * A root-relative link to a page we did not export would 404 on the new host.
   * Sending it back to the original site is the lesser evil, and it is reported.
   */
  it('makes links to unexported pages absolute and reports them', () => {
    const { $, result } = run('<a href="/pricing">x</a>');
    expect($('a').attr('href')).toBe(`${ORIGIN}/pricing`);
    expect(result.leftAbsolute).toBe(1);
    expect(result.warnings.join(' ')).toContain('/pricing');
  });

  it('preserves the fragment when rewriting', () => {
    const { $ } = run('<a href="/about#team">x</a>');
    expect($('a').attr('href')).toBe('about/index.html#team');
  });
});

describe('rewriteCanonical', () => {
  const html = `
    <link rel="canonical" href="${ORIGIN}/about">
    <meta property="og:url" content="${ORIGIN}/about">
  `;

  it('retargets canonical and og:url at the new home', () => {
    const $ = cheerio.load(html);
    rewriteCanonical($, '/about', 'https://example.com');
    expect($('link[rel="canonical"]').attr('href')).toBe('https://example.com/about');
    expect($('meta[property="og:url"]').attr('content')).toBe('https://example.com/about');
  });

  it('maps the root route to a bare slash', () => {
    const $ = cheerio.load('<link rel="canonical" href="x">');
    rewriteCanonical($, '/', 'https://example.com');
    expect($('link[rel="canonical"]').attr('href')).toBe('https://example.com/');
  });

  /** Left pointing at Framer, these would mark the export as a duplicate. */
  it('removes them when no base URL is known', () => {
    const $ = cheerio.load(html);
    rewriteCanonical($, '/about', undefined);
    expect($('link[rel="canonical"]')).toHaveLength(0);
    expect($('meta[property="og:url"]')).toHaveLength(0);
  });
});

describe('auditForms', () => {
  it('flags forms rather than letting them silently swallow leads', () => {
    const $ = cheerio.load('<form action="/api/submit"><input name="email"></form>');
    const result = auditForms($);
    expect(result.count).toBe(1);
    expect($('form').attr('data-unframer-form')).toBe('needs-endpoint');
    // Worded for any site, not just Framer, since the exporter now handles both.
    expect(result.warnings.join(' ')).toMatch(/stops? working once self-hosted/);
    expect(result.warnings.join(' ')).not.toMatch(/Framer/);
  });

  it('says nothing when there are no forms', () => {
    const $ = cheerio.load('<div></div>');
    expect(auditForms($)).toEqual({ count: 0, warnings: [] });
  });
});
