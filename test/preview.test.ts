/**
 * Tests for the bundled preview server.
 *
 * This exists because of the most common way an export appears broken:
 * browsers block ES modules over `file://`, so unzipping a folder and
 * double-clicking index.html loads no JavaScript at all and the site renders
 * completely static. The export therefore has to carry its own way to run.
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePreviewServer } from '../src/preview.js';

async function inTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'unframer-preview-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('writePreviewServer', () => {
  it('writes a launcher for every platform plus instructions', async () => {
    await inTempDir(async (dir) => {
      const { written } = await writePreviewServer(dir);
      expect(written).toEqual(['serve.cjs', 'start.bat', 'start.sh', 'READ-ME-FIRST.txt']);
      const files = await readdir(dir);
      for (const f of written) expect(files).toContain(f);
    });
  });

  /**
   * Node resolves module type by searching PARENT directories for a
   * package.json. An earlier version shipped `serve.js`, assuming a folder
   * without one defaults to CommonJS — so any export unzipped inside an ESM
   * project died with "require is not defined". The extension is the fix.
   */
  it('uses the .cjs extension rather than relying on a default', async () => {
    await inTempDir(async (dir) => {
      await writePreviewServer(dir);
      const files = await readdir(dir);
      expect(files).toContain('serve.cjs');
      expect(files).not.toContain('serve.js');
    });
  });

  /**
   * The test that would have caught the bug: actually run it. Asserting that
   * `require(` appears in the file proved only that the text was there, not
   * that Node would accept it.
   */
  it('actually starts and serves files', { timeout: 30_000 }, async () => {
    await inTempDir(async (dir) => {
      await writePreviewServer(dir);
      await writeFile(join(dir, 'index.html'), '<!doctype html><title>ok</title><p>hello</p>');
      await mkdir(join(dir, 'assets'), { recursive: true });
      await writeFile(join(dir, 'assets', 'app.mjs'), 'export const x = 1;');

      // Run from inside this repo, which is `"type": "module"` — the exact
      // condition that broke the previous version.
      const port = 8100 + Math.floor(Math.random() * 400);
      const child = spawn(process.execPath, [join(dir, 'serve.cjs')], {
        env: { ...process.env, PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';
      child.stderr.on('data', (d) => { stderr += String(d); });

      try {
        // Wait for it to bind.
        const base = `http://127.0.0.1:${port}`;
        let ok = false;
        for (let i = 0; i < 40 && !ok; i++) {
          await new Promise((r) => setTimeout(r, 250));
          try {
            const res = await fetch(base + '/');
            ok = res.ok;
          } catch { /* not up yet */ }
        }

        expect(stderr, 'server wrote to stderr').not.toMatch(/require is not defined|Error/);
        expect(ok, `server never became reachable. stderr: ${stderr}`).toBe(true);

        const page = await fetch(base + '/');
        expect(await page.text()).toContain('hello');
        expect(page.headers.get('content-type')).toContain('text/html');

        // A wrong MIME on .mjs makes the browser refuse the module outright,
        // which is the whole reason this server exists.
        const mod = await fetch(base + '/assets/app.mjs');
        expect(mod.headers.get('content-type')).toContain('text/javascript');

        expect((await fetch(base + '/nope.html')).status).toBe(404);
      } finally {
        child.kill();
      }
    });
  });

  it('serves module and 3D types the runtime needs', async () => {
    await inTempDir(async (dir) => {
      await writePreviewServer(dir);
      const js = await readFile(join(dir, 'serve.cjs'), 'utf8');
      // A wrong MIME type on .mjs makes the browser refuse the module outright.
      expect(js).toContain("'.mjs': 'text/javascript");
      expect(js).toContain("'.glb'");
      expect(js).toContain("'.woff2'");
    });
  });

  it('refuses to serve outside the export folder', async () => {
    await inTempDir(async (dir) => {
      await writePreviewServer(dir);
      const js = await readFile(join(dir, 'serve.cjs'), 'utf8');
      expect(js).toContain('Forbidden');
      expect(js).toContain('startsWith(ROOT');
    });
  });

  /** The whole point: tell people not to double-click index.html. */
  it('explains why opening index.html directly fails', async () => {
    await inTempDir(async (dir) => {
      await writePreviewServer(dir, 'https://example.framer.website/');
      const readme = await readFile(join(dir, 'READ-ME-FIRST.txt'), 'utf8');
      expect(readme).toContain('Do NOT open index.html');
      expect(readme).toMatch(/block/i);
      expect(readme).toContain('start.bat');
      expect(readme).toContain('node serve.cjs');
      expect(readme).toContain('https://example.framer.website/');
    });
  });

  it('says the preview server is not needed once published', async () => {
    await inTempDir(async (dir) => {
      await writePreviewServer(dir);
      const readme = await readFile(join(dir, 'READ-ME-FIRST.txt'), 'utf8');
      expect(readme).toMatch(/static host/i);
      expect(readme).toMatch(/not needed once published|only for viewing locally/i);
    });
  });

  it('checks for Node before running in each launcher', async () => {
    await inTempDir(async (dir) => {
      await writePreviewServer(dir);
      expect(await readFile(join(dir, 'start.bat'), 'utf8')).toContain('nodejs.org');
      expect(await readFile(join(dir, 'start.sh'), 'utf8')).toContain('nodejs.org');
    });
  });
});
