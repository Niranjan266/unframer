/**
 * Minimal static server for verifying an export.
 *
 * The export is deliberately `file://`-safe, but screenshots taken over
 * `file://` differ from real hosting in ways that matter here: no directory
 * index resolution, different origin semantics for fonts, and a different
 * referrer policy. Serving over HTTP makes the verification reflect how the
 * site will actually be deployed.
 *
 * Hand-rolled rather than pulled in, because a verification tool that needs a
 * web framework to check a static site has its priorities wrong.
 */

import { createServer, type Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, resolve, sep } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export interface StaticServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

/**
 * Serve `root` on an ephemeral port.
 *
 * Requests are resolved inside `root` only — a path that escapes it after
 * normalisation is rejected rather than served, since the same traversal
 * sequences that `routeToFilePath` guards against can arrive over the wire.
 */
export async function serveDirectory(rootDir: string): Promise<StaticServer> {
  // Normalise once, up front. The containment check below compares this against
  // a `join()`ed path, and `join()` always emits platform separators — so a
  // caller passing "C:/x/y" on Windows would never match "C:\x\y" and every
  // request would 403. Callers that happened to pass an already-resolved path
  // worked, which is exactly the kind of bug that hides until someone uses the
  // function directly.
  const root = resolve(rootDir);

  const server: Server = createServer(async (req, res) => {
    try {
      const rawPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
      let relative = normalize(rawPath).replace(/^([/\\])+/, '');

      // Reject anything that would climb out of the served directory.
      if (relative.split(/[/\\]/).includes('..')) {
        res.writeHead(403).end('Forbidden');
        return;
      }

      let filePath = join(root, relative);
      if (!filePath.startsWith(root + sep) && filePath !== root) {
        res.writeHead(403).end('Forbidden');
        return;
      }

      // Directory (or bare route) resolves to its index document.
      try {
        const info = await stat(filePath);
        if (info.isDirectory()) filePath = join(filePath, 'index.html');
      } catch {
        if (!extname(filePath)) filePath = join(filePath, 'index.html');
      }

      const body = await readFile(filePath);
      res.writeHead(200, {
        'Content-Type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': body.byteLength,
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
