/**
 * Tests for the verification layer.
 *
 * The probe scripts run in a browser, so what is testable here is their shape
 * and the traps they must encode — several of which produced false results
 * during development and would silently return if the guards were removed.
 */

import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { VERIFY_SCRIPT, CONTENT_PROBE_SCRIPT, SETTLE_SCRIPT } from '../src/verify.js';
import { serveDirectory } from '../src/serve.js';
import { validateHtmlStrings, validateAgainstBaseline } from '../src/validate-html.js';

describe('probe scripts', () => {
  /** finish() throws on the ticker's infinite marquee and crashes the run. */
  it('guards against infinite animations in both scripts', () => {
    for (const script of [VERIFY_SCRIPT, SETTLE_SCRIPT]) {
      expect(script).toContain('Infinity');
      expect(script).toContain('try');
    }
  });

  /** Reveals must be triggered BEFORE animations are finished, or the
   *  transition they start freezes at its from-value. */
  it('reveals before finishing animations', () => {
    const revealAt = VERIFY_SCRIPT.indexOf('uf-in');
    const finishAt = VERIFY_SCRIPT.indexOf('.finish()');
    expect(revealAt).toBeGreaterThan(-1);
    expect(finishAt).toBeGreaterThan(-1);
    expect(revealAt).toBeLessThan(finishAt);
  });

  /** Scoping to appear ids is what let an invisible export pass. */
  it('walks every element, not just animated ones', () => {
    expect(VERIFY_SCRIPT).toContain("querySelectorAll('body *')");
  });

  /** innerText returns text inside opacity:0 elements. */
  it('measures visibility through the ancestor chain', () => {
    expect(CONTENT_PROBE_SCRIPT).toContain('parentElement');
    expect(CONTENT_PROBE_SCRIPT).toContain('visibility');
    expect(CONTENT_PROBE_SCRIPT).toContain('display');
    expect(CONTENT_PROBE_SCRIPT).toContain('opacity');
  });

  /** A 150ms wait against a 700ms transition made the probe report an 80%
   *  content loss that did not exist. Settling must be deterministic. */
  it('settles deterministically rather than by sleeping', () => {
    expect(SETTLE_SCRIPT).toContain('getAnimations');
    expect(SETTLE_SCRIPT).toContain('finish');
  });
});

describe('serveDirectory', () => {
  it('serves a directory and resolves index documents', async () => {
    const server = await serveDirectory(join(process.cwd(), 'test'));
    try {
      const res = await fetch(`${server.url}/fixtures/README.md`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('Test fixtures');
    } finally {
      await server.close();
    }
  });

  /** The same traversal sequences routeToFilePath guards against can arrive
   *  over the wire. */
  it('refuses to serve outside its root', async () => {
    const server = await serveDirectory(join(process.cwd(), 'test'));
    try {
      const res = await fetch(`${server.url}/..%2F..%2Fpackage.json`);
      expect([403, 404]).toContain(res.status);
    } finally {
      await server.close();
    }
  });

  it('404s a missing file rather than throwing', async () => {
    const server = await serveDirectory(join(process.cwd(), 'test'));
    try {
      expect((await fetch(`${server.url}/nope.html`)).status).toBe(404);
    } finally {
      await server.close();
    }
  });
});

describe('html validation', () => {
  it('flags genuinely malformed markup', async () => {
    const result = await validateHtmlStrings([
      { source: '<!DOCTYPE html><html lang="en"><head><title>t</title></head><body><div><span></div></span></body></html>', name: 'bad' },
    ]);
    expect(result.structuralErrors.length).toBeGreaterThan(0);
  });

  it('accepts well-formed markup', async () => {
    const result = await validateHtmlStrings([
      { source: '<!DOCTYPE html><html lang="en"><head><title>t</title></head><body><p>hi</p></body></html>', name: 'good' },
    ]);
    expect(result.structuralErrors).toHaveLength(0);
  });

  /**
   * Framer emits a <style> inside a <div>, identically in source and export.
   * Failing on that would be noise about Framer's house style, not our work.
   */
  it('ignores issues that already exist in the source', async () => {
    const shared = '<!DOCTYPE html><html lang="en"><head><title>t</title></head><body><div><style>a{color:red}</style></div></body></html>';
    const { introduced, preExisting } = await validateAgainstBaseline(shared, shared);
    expect(introduced).toHaveLength(0);
    expect(preExisting.length).toBeGreaterThan(0);
  });

  it('reports issues the export introduced', async () => {
    const original = '<!DOCTYPE html><html lang="en"><head><title>t</title></head><body><p>hi</p></body></html>';
    const exported = '<!DOCTYPE html><html lang="en"><head><title>t</title></head><body><p id="x">hi</p><p id="x">dup</p></body></html>';
    const { introduced } = await validateAgainstBaseline(exported, original);
    expect(introduced.some((i) => i.rule === 'no-dup-id')).toBe(true);
  });
});

describe('exported pages validate', () => {
  it('produces structurally sound HTML', async () => {
    const fixture = join(process.cwd(), 'test', 'fixtures', 'framer-template.html');
    let source: string;
    try {
      source = await readFile(fixture, 'utf8');
    } catch {
      return; // fixture absent on a fresh clone
    }
    const { extract } = await import('../src/extract.js');
    const { html } = extract(source);
    const { introduced } = await validateAgainstBaseline(html, source);
    expect(
      introduced.map((i) => `${i.rule}: ${i.message}`),
      'extraction introduced markup errors',
    ).toHaveLength(0);
  });
});
