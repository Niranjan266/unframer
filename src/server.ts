/**
 * Export server.
 *
 * A small HTTP surface over the extraction engine: submit a URL, watch progress
 * over server-sent events, download a deployable ZIP.
 *
 * Node's own `http` module rather than a framework — the whole API is five
 * routes, and an export tool that needs a web framework to serve five routes
 * has its priorities wrong.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportSite } from './site.js';
import { packageExport } from './package.js';
import { ExportQueue, toJobView, type Job, type JobOptions } from './queue.js';
import { assertPublicUrl, BlockedUrlError } from './ssrf.js';
import { UI_HTML, EXPORT_CODE_HTML } from './ui.js';

/** Cap on request body size, so a client cannot exhaust memory. */
const MAX_BODY_BYTES = 16 * 1024;

export interface ServerOptions {
  port?: number;
  /** Where job artifacts are written. Defaults to a temp directory. */
  workDir?: string;
  concurrency?: number;
  /** Upper bound on pages per job, regardless of what a client requests. */
  maxPagesLimit?: number;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) throw new Error('Request body too large');
    chunks.push(chunk as Buffer);
  }

  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Request body is not valid JSON');
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

/** Build the job runner: export the site, then package it. */
function makeRunner(workDir: string) {
  return async (job: Job, onProgress: (message: string) => void) => {
    const dir = join(workDir, job.id);

    onProgress('Discovering routes');
    const report = await exportSite(job.options.url, {
      outDir: dir,
      assetMode: job.options.assetMode,
      baseUrl: job.options.baseUrl,
      maxPages: job.options.maxPages,
      compileAnimations: job.options.compileAnimations,
      keepRuntime: job.options.keepRuntime ?? false,
      allowNonFramer: job.options.allowNonFramer ?? false,
      onProgress: (done, total, route, ok) =>
        onProgress(`${ok ? 'Exported' : 'Failed'} ${route} (${done}/${total})`),
      onAssetProgress: (done, total, _url, ok) => {
        if (!ok || done === total || done % 25 === 0) {
          onProgress(`Assets ${done}/${total}${ok ? '' : ' — one failed, kept CDN URL'}`);
        }
      },
    });

    if (report.pagesExported === 0) {
      throw new Error('No pages could be exported. Is this a published Framer site?');
    }

    // The preview server is what makes an unzipped folder actually runnable.
    if (job.options.includePreview) {
      onProgress('Adding preview server');
      const { writePreviewServer } = await import('./preview.js');
      await writePreviewServer(dir, job.options.url);
    }

    onProgress('Packaging');
    const { zip } = await packageExport(dir, `${dir}.zip`);

    onProgress('Done');
    return { report, zipPath: zip.path, zipBytes: zip.bytes };
  };
}

export interface RunningServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const workDir = options.workDir ?? (await mkdtemp(join(tmpdir(), 'unframer-')));
  const maxPagesLimit = options.maxPagesLimit ?? 100;
  const queue = new ExportQueue(makeRunner(workDir), options.concurrency ?? 1);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    try {
      // --- UI ---------------------------------------------------------------
      if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(UI_HTML);
        return;
      }

      if (req.method === 'GET' && (path === '/exportcode' || path === '/exportcode/')) {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(EXPORT_CODE_HTML);
        return;
      }

      // --- create a job -----------------------------------------------------
      if (req.method === 'POST' && path === '/api/jobs') {
        const body = await readJson(req);
        const rawUrl = typeof body.url === 'string' ? body.url.trim() : '';

        if (!rawUrl) {
          sendJson(res, 400, { error: 'A site URL is required.' });
          return;
        }

        // Never fetch a user-supplied URL without checking where it points.
        let target: URL;
        try {
          target = await assertPublicUrl(rawUrl);
        } catch (err) {
          sendJson(res, 400, {
            error: err instanceof BlockedUrlError ? err.message : 'That URL could not be used.',
          });
          return;
        }

        const requestedPages = Number(body.maxPages);

        // "full" is the exportcode pipeline: keep the runtime, download every
        // asset, and ship a preview server so the result actually runs.
        const full = body.mode === 'full';

        const jobOptions: JobOptions = {
          url: target.toString(),
          assetMode: full || body.assetMode === 'offline' ? 'offline' : 'hotlink',
          baseUrl: typeof body.baseUrl === 'string' && body.baseUrl ? body.baseUrl : undefined,
          maxPages: Number.isFinite(requestedPages)
            ? Math.min(Math.max(1, requestedPages), maxPagesLimit)
            : Math.min(25, maxPagesLimit),
          compileAnimations: full ? false : body.compileAnimations !== false,
          keepRuntime: full,
          includePreview: full,
          // The Export code page works on any site, so a page that is not
          // Framer takes the generic path instead of being refused.
          allowNonFramer: full,
        };

        const job = queue.enqueue(jobOptions);
        sendJson(res, 202, toJobView(job));
        return;
      }

      // --- list jobs --------------------------------------------------------
      if (req.method === 'GET' && path === '/api/jobs') {
        sendJson(res, 200, { jobs: queue.list().map(toJobView) });
        return;
      }

      const jobMatch = path.match(/^\/api\/jobs\/([0-9a-f-]{36})(\/events|\/download)?$/i);
      if (jobMatch) {
        const job = queue.get(jobMatch[1]);
        if (!job) {
          sendJson(res, 404, { error: 'No such job.' });
          return;
        }

        // --- progress stream ------------------------------------------------
        if (jobMatch[2] === '/events') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
          });

          const send = (j: Job) => {
            res.write(`data: ${JSON.stringify(toJobView(j))}\n\n`);
            if (j.status === 'done' || j.status === 'failed') res.end();
          };

          send(job);
          if (job.status === 'done' || job.status === 'failed') return;

          const unsubscribe = queue.subscribe(job.id, send);
          req.on('close', unsubscribe);
          return;
        }

        // --- download -------------------------------------------------------
        if (jobMatch[2] === '/download') {
          // Only ever the path this job produced; never anything client-supplied.
          if (job.status !== 'done' || !job.zipPath) {
            sendJson(res, 409, { error: 'This export is not ready yet.' });
            return;
          }

          const info = await stat(job.zipPath).catch(() => null);
          if (!info) {
            sendJson(res, 410, { error: 'This export has expired.' });
            return;
          }

          const name = `${new URL(job.options.url).hostname.replace(/[^a-z0-9.-]/gi, '-')}.zip`;
          res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Length': info.size,
            'Content-Disposition': `attachment; filename="${name}"`,
          });
          createReadStream(job.zipPath).pipe(res);
          return;
        }

        sendJson(res, 200, toJobView(job));
        return;
      }

      sendJson(res, 404, { error: 'Not found.' });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : 'Server error.' });
    }
  });

  const port = options.port ?? 0;
  await new Promise<void>((resolvePromise) => server.listen(port, resolvePromise));
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;

  return {
    port: actualPort,
    url: `http://localhost:${actualPort}`,
    close: async () => {
      await new Promise<void>((resolvePromise, reject) =>
        server.close((err) => (err ? reject(err) : resolvePromise())),
      );
      if (!options.workDir) await rm(workDir, { recursive: true, force: true });
    },
  };
}
