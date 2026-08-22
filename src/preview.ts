/**
 * Self-contained preview server, written into every export.
 *
 * Browsers refuse to load ES modules over `file://` — it is a CORS rule, not a
 * bug — so double-clicking `index.html` loads zero JavaScript and the page
 * renders as the static server-rendered shell: no animation, no interaction,
 * no hydration. That looks exactly like a broken export, and it is the single
 * most likely thing to happen to someone who unzips a folder.
 *
 * So the export carries its own way to run: a dependency-free Node server and
 * a double-clickable launcher for each platform. Nothing to install beyond the
 * Node the exporter already required.
 */

import { writeFile, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * A tiny static server with no dependencies, shipped inside the export.
 *
 * The `.cjs` extension is load-bearing. Node resolves module type by walking UP
 * the directory tree for the nearest package.json, so an export unzipped
 * anywhere beneath a project with `"type": "module"` would have a plain `.js`
 * server treated as ESM, and `require` would throw before the server ever
 * bound a port. `.cjs` forces CommonJS regardless of where the folder lands.
 */
const SERVER_JS = `#!/usr/bin/env node
/*
 * Local preview server for this exported site.
 *
 * Browsers block ES modules loaded over file://, so opening index.html
 * directly shows the page without any of its JavaScript - no animations and
 * no interactions. Serving over HTTP is what makes the site behave the way it
 * does when published.
 *
 * Run:  node serve.cjs
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8080;

const MIME = {
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
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
};

http.createServer((req, res) => {
  let rel;
  try {
    rel = decodeURIComponent(req.url.split('?')[0]);
  } catch (e) {
    res.writeHead(400).end('Bad request');
    return;
  }

  let filePath = path.join(ROOT, path.normalize(rel).replace(/^([/\\\\])+/, ''));

  // Never serve outside this folder.
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, info) => {
    if (!err && info.isDirectory()) filePath = path.join(filePath, 'index.html');
    else if (err && !path.extname(filePath)) filePath = path.join(filePath, 'index.html');

    fs.readFile(filePath, (readErr, body) => {
      if (readErr) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
      });
      res.end(body);
    });
  });
}).listen(PORT, () => {
  const url = 'http://localhost:' + PORT + '/';
  console.log('');
  console.log('  Your site is running at ' + url);
  console.log('  Press Ctrl+C to stop.');
  console.log('');

  // Best-effort browser open; harmless if it fails.
  const open = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  try {
    require('child_process').spawn(open[0], open[1], { stdio: 'ignore', detached: true }).unref();
  } catch (e) { /* open it yourself */ }
});
`;

const START_BAT = `@echo off
REM Double-click this to view the site with all animations working.
REM
REM Opening index.html directly does NOT work: browsers block JavaScript
REM modules loaded from a file path, so the page would render without any
REM of its animation or interaction.

cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo   Node.js is required to preview this site locally.
    echo   Install it from https://nodejs.org/ and run this again.
    echo.
    echo   You can also upload this folder to any web host, where it
    echo   will work without Node.
    echo.
    pause
    exit /b 1
)

node serve.cjs
pause
`;

const START_SH = `#!/bin/sh
# Run this to view the site with all animations working.
#
# Opening index.html directly does NOT work: browsers block JavaScript modules
# loaded from a file path, so the page renders without animation or interaction.

cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js is required to preview this site locally."
  echo "  Install it from https://nodejs.org/ and run this again."
  echo
  echo "  You can also upload this folder to any web host, where it"
  echo "  will work without Node."
  echo
  exit 1
fi

node serve.cjs
`;

function readme(sourceUrl: string | undefined): string {
  const source = sourceUrl ? `Exported from ${sourceUrl}\n\n` : '';
  return `${source}HOW TO VIEW THIS SITE
=====================

Do NOT open index.html by double-clicking it.

Browsers block JavaScript modules loaded from a file path, so opening the
file directly shows the page with no animations and no interactivity. This
is a browser security rule, not a problem with the export.

To view it properly:

  Windows      double-click  start.bat
  Mac / Linux  run           ./start.sh
  Any system   run           node serve.cjs

Then open http://localhost:8080/ if it does not open by itself.


TO PUBLISH IT
=============

Upload the whole folder to any static host. It works as-is on Netlify,
Vercel, Cloudflare Pages, GitHub Pages, or any normal web server - none of
them need the preview server, which is only for viewing locally.

Configuration for the common hosts is already included:

  netlify.toml   Netlify
  vercel.json    Vercel
  _headers       Netlify and Cloudflare Pages

Cache headers are set so that files under assets/ are cached permanently
(their names contain a content hash, so they never change) while HTML is
always revalidated.


WHAT IS IN HERE
===============

  index.html       the page
  assets/images    every image, at every size the page uses
  assets/fonts     every font
  assets/media     video and audio
  assets/runtime   the JavaScript that drives animations and interactions
  serve.cjs        local preview server (not needed once published)
`;
}

export interface PreviewFiles {
  written: string[];
}

/**
 * Write the preview server and its launchers into an export directory.
 *
 * `serve.cjs` uses CommonJS via its extension, not by hoping for a default.
 * An earlier version shipped `serve.js` on the assumption that a folder with
 * no package.json defaults to CommonJS — but Node searches parent directories,
 * so an export unzipped inside any ESM project failed with "require is not
 * defined" before binding a port.
 */
export async function writePreviewServer(
  dir: string,
  sourceUrl?: string,
): Promise<PreviewFiles> {
  const root = resolve(dir);

  await writeFile(join(root, 'serve.cjs'), SERVER_JS, 'utf8');
  await writeFile(join(root, 'start.bat'), START_BAT, 'utf8');
  await writeFile(join(root, 'start.sh'), START_SH, 'utf8');
  await writeFile(join(root, 'READ-ME-FIRST.txt'), readme(sourceUrl), 'utf8');

  // Best effort: Windows filesystems ignore the mode, and a ZIP round-trip
  // drops it anyway, which the README covers by also giving the `node` command.
  await chmod(join(root, 'start.sh'), 0o755).catch(() => {});

  return { written: ['serve.cjs', 'start.bat', 'start.sh', 'READ-ME-FIRST.txt'] };
}
