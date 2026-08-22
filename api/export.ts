/**
 * Serverless export endpoint.
 *
 * The full exporter does not fit a serverless platform and pretending otherwise
 * would ship a page that fails on every click. Three limits decide the shape of
 * this function:
 *
 *   - A function is billed by wall-clock time and capped in the tens of
 *     seconds. Downloading a few hundred assets takes minutes.
 *   - The filesystem is read-only apart from a temp directory that disappears
 *     when the invocation ends, so there is nowhere to keep an artifact for a
 *     later download request.
 *   - A response body is capped at a few megabytes, while a full offline export
 *     runs to tens or hundreds.
 *
 * So this does the one thing that genuinely fits: a small, CDN-linked export,
 * built and returned inside a single request. Assets keep pointing at their
 * original host, which is what keeps the response small enough to send.
 *
 * Anything larger belongs on a machine that can hold state — the Dockerfile in
 * this repo runs the complete pipeline with no such limits.
 */

import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportSite } from '../src/site.js';
import { createZip } from '../src/package.js';
import { assertPublicUrl, BlockedUrlError } from '../src/ssrf.js';

/** Minimal shape of the request and response, so this needs no extra dependency. */
interface Req {
  method?: string;
  body?: unknown;
}
interface Res {
  status(code: number): Res;
  json(body: unknown): void;
  send(body: unknown): void;
  setHeader(name: string, value: string): void;
}

/** Pages per export. Deliberately small — each one costs wall-clock time. */
const MAX_PAGES = 5;

/** Response ceiling. Vercel rejects bodies past a few megabytes. */
const MAX_ZIP_BYTES = 4 * 1024 * 1024;

export const config = { maxDuration: 60 };

export default async function handler(req: Req, res: Res): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST.' });
    return;
  }

  const body = (typeof req.body === 'string' ? safeParse(req.body) : req.body) as
    | Record<string, unknown>
    | undefined;

  const rawUrl = typeof body?.url === 'string' ? body.url.trim() : '';
  if (!rawUrl) {
    res.status(400).json({ error: 'A site URL is required.' });
    return;
  }

  let target: URL;
  try {
    // Never fetch a user-supplied URL without checking where it points.
    target = await assertPublicUrl(rawUrl);
  } catch (err) {
    res.status(400).json({
      error: err instanceof BlockedUrlError ? err.message : 'That URL could not be used.',
    });
    return;
  }

  const requested = Number(body?.maxPages);
  const maxPages = Number.isFinite(requested)
    ? Math.min(Math.max(1, requested), MAX_PAGES)
    : 1;

  const workDir = await mkdtemp(join(tmpdir(), 'unframer-'));
  const outDir = join(workDir, 'site');
  const zipPath = join(workDir, 'site.zip');

  try {
    const report = await exportSite(target.toString(), {
      outDir,
      // CDN-linked, not downloaded. Downloading is what blows both the time
      // budget and the response size.
      assetMode: 'hotlink',
      keepRuntime: true,
      allowNonFramer: true,
      compileAnimations: false,
      maxPages,
      concurrency: 6,
    });

    if (report.pagesExported === 0) {
      const reason = report.pages.find((p) => p.error)?.error;
      res.status(422).json({
        error: reason ? `Could not export this site: ${reason}` : 'No pages were reachable.',
      });
      return;
    }

    const zip = await createZip(outDir, zipPath);

    if (zip.bytes > MAX_ZIP_BYTES) {
      res.status(413).json({
        error:
          `This export is ${(zip.bytes / 1048576).toFixed(1)} MB, past what this hosted ` +
          `version can return. Run it locally for the complete copy — see the README.`,
      });
      return;
    }

    const name = target.hostname.replace(/[^a-z0-9.-]/gi, '-');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.zip"`);
    res.setHeader('X-Unframer-Pages', String(report.pagesExported));
    res.setHeader('X-Unframer-Assets', String(report.uniqueAssets));
    res.setHeader('X-Unframer-Removed', String(report.totalArtifactsRemoved));
    res.send(await readFile(zipPath));
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'The export failed.',
    });
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
