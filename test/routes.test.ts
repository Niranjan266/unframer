import { describe, it, expect } from 'vitest';
import {
  normalizeRoute,
  routeToFilePath,
  routeDepth,
  extractLinks,
  buildSitemap,
  buildRobots,
} from '../src/routes.js';

const ORIGIN = 'https://example.framer.website';

describe('normalizeRoute', () => {
  it('reduces absolute same-origin URLs to a path', () => {
    expect(normalizeRoute(`${ORIGIN}/about`, ORIGIN)).toBe('/about');
    expect(normalizeRoute(`${ORIGIN}/`, ORIGIN)).toBe('/');
  });

  it('resolves relative URLs against the origin', () => {
    expect(normalizeRoute('/blog/post', ORIGIN)).toBe('/blog/post');
  });

  it('drops the trailing slash but keeps root as "/"', () => {
    expect(normalizeRoute(`${ORIGIN}/about/`, ORIGIN)).toBe('/about');
    expect(normalizeRoute(`${ORIGIN}/`, ORIGIN)).toBe('/');
  });

  it('ignores hash and query, which do not identify a static page', () => {
    expect(normalizeRoute(`${ORIGIN}/about#team`, ORIGIN)).toBe('/about');
    expect(normalizeRoute(`${ORIGIN}/about?ref=x`, ORIGIN)).toBe('/about');
  });

  it('rejects off-origin links', () => {
    expect(normalizeRoute('https://google.com/x', ORIGIN)).toBeNull();
  });

  it('rejects non-page assets', () => {
    expect(normalizeRoute(`${ORIGIN}/logo.png`, ORIGIN)).toBeNull();
    expect(normalizeRoute(`${ORIGIN}/app.mjs`, ORIGIN)).toBeNull();
  });

  it('rejects non-http protocols', () => {
    expect(normalizeRoute('mailto:a@b.com', ORIGIN)).toBeNull();
    expect(normalizeRoute('javascript:alert(1)', ORIGIN)).toBeNull();
  });
});

describe('routeToFilePath', () => {
  it('maps root to index.html', () => {
    expect(routeToFilePath('/')).toBe('index.html');
    expect(routeToFilePath('')).toBe('index.html');
  });

  it('uses directory style so URLs stay clean', () => {
    expect(routeToFilePath('/about')).toBe('about/index.html');
    expect(routeToFilePath('/blog/my-post')).toBe('blog/my-post/index.html');
  });

  /** Routes come from crawled pages, so they are untrusted input. */
  it('refuses path traversal', () => {
    expect(() => routeToFilePath('/../../etc/passwd')).toThrow(/Unsafe route segment/);
    expect(() => routeToFilePath('/a/../b')).toThrow(/Unsafe route segment/);
  });

  it('refuses backslash and drive-letter injection', () => {
    expect(() => routeToFilePath('/a\\b')).toThrow(/Unsafe route segment/);
    expect(() => routeToFilePath('/C:/windows')).toThrow(/Unsafe route segment/);
  });

  it('sanitises characters that are illegal in Windows filenames', () => {
    expect(routeToFilePath('/a?b')).toBe('a-b/index.html');
    expect(routeToFilePath('/a*b')).toBe('a-b/index.html');
  });
});

describe('routeDepth', () => {
  it('counts path segments', () => {
    expect(routeDepth('/')).toBe(0);
    expect(routeDepth('/about')).toBe(1);
    expect(routeDepth('/blog/post')).toBe(2);
  });
});

describe('extractLinks', () => {
  const html = `
    <a href="/about">a</a>
    <a href="${ORIGIN}/blog/post">b</a>
    <a href="https://external.com/x">c</a>
    <a href="#anchor">d</a>
    <a href="mailto:x@y.com">e</a>
    <a href="/logo.png">f</a>
  `;

  it('finds same-origin page links only', () => {
    const links = extractLinks(html, `${ORIGIN}/`, ORIGIN);
    expect(links).toContain('/about');
    expect(links).toContain('/blog/post');
    expect(links).not.toContain('/logo.png');
    expect(links.some((l) => l.includes('external.com'))).toBe(false);
  });

  it('deduplicates', () => {
    const dup = `<a href="/about">1</a><a href="${ORIGIN}/about/">2</a>`;
    expect(extractLinks(dup, `${ORIGIN}/`, ORIGIN)).toEqual(['/about']);
  });
});

describe('site files', () => {
  const routes = [
    { path: '/', url: `${ORIGIN}/`, source: 'entry' as const },
    { path: '/about', url: `${ORIGIN}/about`, source: 'sitemap' as const },
  ];

  it('builds a sitemap with absolute URLs when a base is given', () => {
    const xml = buildSitemap(routes, 'https://example.com');
    expect(xml).toContain('<loc>https://example.com/</loc>');
    expect(xml).toContain('<loc>https://example.com/about</loc>');
  });

  it('escapes XML entities', () => {
    const xml = buildSitemap([{ path: '/a&b', url: '', source: 'crawl' }], 'https://e.com');
    expect(xml).toContain('&amp;');
  });

  it('points robots.txt at the sitemap', () => {
    expect(buildRobots('https://example.com')).toContain(
      'Sitemap: https://example.com/sitemap.xml',
    );
  });
});
