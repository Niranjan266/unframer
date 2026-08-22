/**
 * Packaging.
 *
 * Turns an export directory into something deployable: host configuration for
 * the common static platforms, plus a ZIP.
 *
 * The cache headers here are not boilerplate. Asset filenames carry a hash of
 * their source URL (`hero-a1b2c3d4.png`), so an asset can never change content
 * without changing name — which makes `immutable` genuinely correct for
 * `assets/`. HTML has no such guarantee and must revalidate, or a deploy would
 * leave visitors on a stale page pointing at assets that no longer exist.
 */

import { createWriteStream } from 'node:fs';
import { writeFile, readdir, stat } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
// This archiver version exports classes rather than a callable default.
import { ZipArchive, type ArchiverError } from 'archiver';

/** One year, the conventional maximum for immutable assets. */
const ASSET_MAX_AGE = 31_536_000;

export interface HostConfigOptions {
  /** Emit `netlify.toml` and `_headers`. */
  netlify?: boolean;
  /** Emit `vercel.json`. */
  vercel?: boolean;
  /** Emit `_headers` for Cloudflare Pages (same format as Netlify). */
  cloudflare?: boolean;
}

/**
 * Netlify / Cloudflare Pages `_headers`.
 *
 * Both read the same format, so one file serves either.
 */
export function buildHeadersFile(): string {
  return [
    '# Assets are content-hashed, so they can never change under a given name.',
    '/assets/*',
    `  Cache-Control: public, max-age=${ASSET_MAX_AGE}, immutable`,
    '',
    '# HTML must revalidate, or a deploy strands visitors on a stale page.',
    '/*.html',
    '  Cache-Control: public, max-age=0, must-revalidate',
    '/',
    '  Cache-Control: public, max-age=0, must-revalidate',
    '',
    '# The export ships no inline third-party code and phones home to nobody.',
    '/*',
    '  X-Content-Type-Options: nosniff',
    '  Referrer-Policy: strict-origin-when-cross-origin',
    '',
  ].join('\n');
}

export function buildNetlifyToml(): string {
  return [
    '[build]',
    '  publish = "."',
    '',
    '[[headers]]',
    '  for = "/assets/*"',
    '  [headers.values]',
    `    Cache-Control = "public, max-age=${ASSET_MAX_AGE}, immutable"`,
    '',
    '[[headers]]',
    '  for = "/*"',
    '  [headers.values]',
    '    X-Content-Type-Options = "nosniff"',
    '    Referrer-Policy = "strict-origin-when-cross-origin"',
    '',
  ].join('\n');
}

export function buildVercelJson(): string {
  return `${JSON.stringify(
    {
      $schema: 'https://openapi.vercel.sh/vercel.json',
      // Routes are directory-style, so /about serves about/index.html.
      cleanUrls: true,
      trailingSlash: false,
      headers: [
        {
          source: '/assets/(.*)',
          headers: [
            { key: 'Cache-Control', value: `public, max-age=${ASSET_MAX_AGE}, immutable` },
          ],
        },
        {
          source: '/(.*)',
          headers: [
            { key: 'X-Content-Type-Options', value: 'nosniff' },
            { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          ],
        },
      ],
    },
    null,
    2,
  )}\n`;
}

/** Write host configuration into an export directory. */
export async function writeHostConfigs(
  dir: string,
  options: HostConfigOptions = { netlify: true, vercel: true, cloudflare: true },
): Promise<string[]> {
  const written: string[] = [];
  const root = resolve(dir);

  if (options.netlify) {
    await writeFile(join(root, 'netlify.toml'), buildNetlifyToml(), 'utf8');
    written.push('netlify.toml');
  }
  if (options.vercel) {
    await writeFile(join(root, 'vercel.json'), buildVercelJson(), 'utf8');
    written.push('vercel.json');
  }
  if (options.netlify || options.cloudflare) {
    await writeFile(join(root, '_headers'), buildHeadersFile(), 'utf8');
    written.push('_headers');
  }

  return written;
}

export interface ZipResult {
  path: string;
  bytes: number;
  files: number;
}

/** Recursively list files under a directory, as paths relative to it. */
export async function listFiles(dir: string): Promise<string[]> {
  const root = resolve(dir);
  const out: string[] = [];

  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(relative(root, full).split('\\').join('/'));
    }
  }

  await walk(root);
  return out.sort();
}

/**
 * Zip an export directory.
 *
 * The archive is written outside the directory being zipped by default —
 * placing it inside would race with its own traversal.
 */
export async function createZip(dir: string, outputPath: string): Promise<ZipResult> {
  const root = resolve(dir);
  const target = resolve(outputPath);
  const files = await listFiles(root);

  await new Promise<void>((resolvePromise, reject) => {
    const output = createWriteStream(target);
    const archive = new ZipArchive({ zlib: { level: 9 } });

    output.on('close', resolvePromise);
    output.on('error', reject);
    archive.on('error', reject);
    // Missing-file warnings would otherwise pass silently.
    archive.on('warning', (err: ArchiverError) => {
      if (err.code !== 'ENOENT') reject(err);
    });

    archive.pipe(output);
    archive.directory(root, false);
    void archive.finalize();
  });

  const info = await stat(target);
  return { path: target, bytes: info.size, files: files.length };
}

/** Prepare an export for deployment: host configs, then a ZIP. */
export async function packageExport(
  dir: string,
  zipPath: string,
  options?: HostConfigOptions,
): Promise<{ configs: string[]; zip: ZipResult }> {
  const configs = await writeHostConfigs(dir, options);
  const zip = await createZip(dir, zipPath);
  return { configs, zip };
}
