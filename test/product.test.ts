/**
 * Tests for the product surface: SSRF guard, job queue, packaging.
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPrivateAddress, assertPublicUrl, BlockedUrlError } from '../src/ssrf.js';
import { ExportQueue, toJobView, type JobOptions } from '../src/queue.js';
import {
  buildHeadersFile,
  buildVercelJson,
  buildNetlifyToml,
  writeHostConfigs,
  createZip,
  listFiles,
} from '../src/package.js';

describe('SSRF guard', () => {
  /**
   * The server fetches a URL supplied by whoever is using it. Unguarded that is
   * a request forwarder into the host's private network.
   */
  it('rejects loopback, private, link-local and reserved ranges', () => {
    for (const addr of [
      '127.0.0.1', '127.1.2.3',      // loopback
      '10.0.0.1', '172.16.5.4', '192.168.1.1', // private
      '169.254.169.254',              // cloud metadata
      '100.64.0.1',                   // carrier-grade NAT
      '0.0.0.0',                      // this network
      '224.0.0.1', '255.255.255.255', // multicast / reserved
      '::1', 'fe80::1', 'fd00::1',    // IPv6 loopback / link-local / ULA
      '::ffff:127.0.0.1',             // IPv4-mapped loopback
    ]) {
      expect(isPrivateAddress(addr), `${addr} should be blocked`).toBe(true);
    }
  });

  it('allows ordinary public addresses', () => {
    for (const addr of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700::1111']) {
      expect(isPrivateAddress(addr), `${addr} should be allowed`).toBe(false);
    }
  });

  it('blocks non-HTTP schemes', async () => {
    for (const url of ['file:///etc/passwd', 'ftp://example.com/', 'gopher://x/']) {
      await expect(assertPublicUrl(url)).rejects.toThrow(BlockedUrlError);
    }
  });

  it('blocks localhost by name', async () => {
    await expect(assertPublicUrl('http://localhost:6379/')).rejects.toThrow(/localhost/);
    await expect(assertPublicUrl('http://foo.localhost/')).rejects.toThrow(/localhost/);
  });

  it('blocks a literal private IP', async () => {
    await expect(assertPublicUrl('http://169.254.169.254/')).rejects.toThrow(/private or reserved/);
  });

  it('rejects malformed input', async () => {
    await expect(assertPublicUrl('not a url')).rejects.toThrow(BlockedUrlError);
  });
});

describe('ExportQueue', () => {
  const options: JobOptions = {
    url: 'https://example.framer.website/',
    assetMode: 'hotlink',
    maxPages: 5,
    compileAnimations: true,
  };

  const fakeReport = { pagesExported: 1 } as never;

  it('runs a job to completion and records progress', async () => {
    const queue = new ExportQueue(async (_job, onProgress) => {
      onProgress('one');
      onProgress('two');
      return { report: fakeReport, zipPath: '/tmp/x.zip', zipBytes: 123 };
    });

    const job = queue.enqueue(options);
    expect(job.status).toBe('queued');

    await new Promise<void>((resolve) => {
      queue.subscribe(job.id, (j) => { if (j.status === 'done') resolve(); });
    });

    expect(job.status).toBe('done');
    expect(job.progress.map((p) => p.message)).toEqual(['one', 'two']);
    expect(job.zipBytes).toBe(123);
  });

  it('captures a failure without throwing', async () => {
    const queue = new ExportQueue(async () => { throw new Error('boom'); });
    const job = queue.enqueue(options);

    await new Promise<void>((resolve) => {
      queue.subscribe(job.id, (j) => { if (j.status === 'failed') resolve(); });
    });

    expect(job.status).toBe('failed');
    expect(job.error).toBe('boom');
  });

  /** Each job already runs its own fetch pool; overlapping them trips the CDN. */
  it('honours the concurrency cap', async () => {
    let active = 0;
    let peak = 0;
    const queue = new ExportQueue(async () => {
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
      return { report: fakeReport, zipPath: '', zipBytes: 0 };
    }, 2);

    const jobs = [1, 2, 3, 4, 5].map(() => queue.enqueue(options));
    await new Promise<void>((resolve) => {
      let done = 0;
      for (const j of jobs) {
        queue.subscribe(j.id, (job) => {
          if (job.status === 'done' && ++done === jobs.length) resolve();
        });
      }
    });

    expect(peak).toBeLessThanOrEqual(2);
  });

  /** A throwing listener must not take the job down with it. */
  it('survives a listener that throws', async () => {
    const queue = new ExportQueue(async () => ({
      report: fakeReport, zipPath: '', zipBytes: 0,
    }));
    const job = queue.enqueue(options);
    queue.subscribe(job.id, () => { throw new Error('listener blew up'); });

    await new Promise((r) => setTimeout(r, 60));
    expect(job.status).toBe('done');
  });

  it('never exposes filesystem paths in the public view', () => {
    const queue = new ExportQueue(async () => ({ report: fakeReport, zipPath: '/secret/x.zip', zipBytes: 1 }));
    const job = queue.enqueue(options);
    job.status = 'done';
    job.zipPath = '/secret/path/export.zip';

    const view = toJobView(job);
    expect(JSON.stringify(view)).not.toContain('/secret');
    expect(view.downloadUrl).toBe(`/api/jobs/${job.id}/download`);
  });
});

describe('host configs', () => {
  /**
   * Asset names carry a hash of their source URL, so content cannot change
   * under a given name — which is what makes `immutable` correct here.
   */
  it('caches hashed assets immutably', () => {
    expect(buildHeadersFile()).toContain('immutable');
    expect(buildNetlifyToml()).toContain('immutable');
    expect(buildVercelJson()).toContain('immutable');
  });

  /** HTML has no such guarantee; caching it strands visitors after a deploy. */
  it('makes HTML revalidate', () => {
    expect(buildHeadersFile()).toContain('max-age=0, must-revalidate');
  });

  it('emits valid JSON for Vercel with clean URLs', () => {
    const parsed = JSON.parse(buildVercelJson());
    expect(parsed.cleanUrls).toBe(true);
    expect(Array.isArray(parsed.headers)).toBe(true);
  });

  it('writes every config file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'unframer-cfg-'));
    try {
      const written = await writeHostConfigs(dir);
      expect(written).toEqual(['netlify.toml', 'vercel.json', '_headers']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('createZip', () => {
  it('archives the directory tree and stays readable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'unframer-zip-'));
    try {
      await mkdir(join(dir, 'nested'), { recursive: true });
      await writeFile(join(dir, 'index.html'), '<!doctype html><title>a</title>');
      await writeFile(join(dir, 'nested', 'index.html'), '<!doctype html><title>b</title>');

      const files = await listFiles(dir);
      expect(files).toEqual(['index.html', 'nested/index.html']);

      const zipPath = join(tmpdir(), `unframer-test-${Date.now()}.zip`);
      const result = await createZip(dir, zipPath);
      expect(result.files).toBe(2);
      expect(result.bytes).toBeGreaterThan(0);

      // ZIP local file header magic.
      const { readFile } = await import('node:fs/promises');
      const buf = await readFile(zipPath);
      expect(buf[0]).toBe(0x50);
      expect(buf[1]).toBe(0x4b);

      await rm(zipPath, { force: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
