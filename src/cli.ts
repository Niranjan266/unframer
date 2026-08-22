#!/usr/bin/env node
/**
 * Unframer CLI.
 *
 * A URL exports the whole site by default — that is what people actually want,
 * and single-page was only ever the phase 01 shape. `--single` keeps the old
 * behaviour for one page.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { extract, NotAFramerSiteError } from './extract.js';
import { fetchPage } from './fetch.js';
import { exportSite, type SiteReport } from './site.js';
import type { AssetMode, ExtractReport } from './types.js';

interface Args {
  input?: string;
  out: string;
  assetMode: AssetMode;
  compileAnimations: boolean;
  single: boolean;
  sitemapOnly: boolean;
  json: boolean;
  help: boolean;
  baseUrl?: string;
  maxPages: number;
  maxDepth: number;
  concurrency: number;
  pkg: boolean;
  keepRuntime: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    out: 'out',
    assetMode: 'hotlink',
    compileAnimations: true,
    single: false,
    sitemapOnly: false,
    json: false,
    help: false,
    maxPages: 100,
    maxDepth: 3,
    concurrency: 4,
    pkg: false,
    keepRuntime: false,
  };

  const int = (v: string | undefined, fallback: number) => {
    const n = Number.parseInt(v ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--out' || a === '-o') args.out = argv[++i] ?? 'out';
    else if (a === '--base-url') args.baseUrl = argv[++i];
    else if (a === '--offline') args.assetMode = 'offline';
    else if (a === '--no-animations') args.compileAnimations = false;
    else if (a === '--single') args.single = true;
    else if (a === '--sitemap-only') args.sitemapOnly = true;
    else if (a === '--max-pages') args.maxPages = int(argv[++i], 100);
    else if (a === '--max-depth') args.maxDepth = int(argv[++i], 3);
    else if (a === '--concurrency') args.concurrency = int(argv[++i], 4);
    else if (a === '--json') args.json = true;
    else if (a === '--package' || a === '--zip') args.pkg = true;
    else if (a === '--keep-runtime' || a === '--full') args.keepRuntime = true;
    else if (!a.startsWith('-')) args.input = a;
  }
  return args;
}

const HELP = `
unframer — convert a published Framer site into portable static HTML

Usage
  unframer <url|file> [options]

Options
  -o, --out <dir>        Output directory (default: out)
      --base-url <url>   Final public URL; rewrites canonical/og:url and sitemap
      --single           Export only the given page
      --sitemap-only     Discover routes from sitemap.xml only, skip crawling
      --max-pages <n>    Page cap for discovery (default: 100)
      --max-depth <n>    Crawl depth (default: 3)
      --concurrency <n>  Parallel fetches (default: 4 — the CDN throttles)
      --offline          Download every asset for a fully portable package
      --no-animations    Skip animation compilation; force final visible state
      --keep-runtime     Keep Framer's runtime for full animation fidelity
      --package          Also write host configs and a deployable ZIP
      --json             Print the report as JSON
  -h, --help             Show this help

Export a complete, working copy (recommended)
  unframer exportsite <url> [--out site] [--base-url https://example.com]

      Keeps every animation, component and 3D visual working, downloads all
      assets, and includes a local preview server.

Run the web UI and API
  unframer serve [--port 3000] [--concurrency 1]

Verify an export against the live original
  unframer verify <original-url> --export <dir> [options]

      --export <dir>     Export directory to check (default: out)
      --routes a,b       Routes to check (default: every page in the export)
      --viewports w,w    Widths to check (default: 1512,900,390)
      --diff-dir <dir>   Where to write diff images (default: verify-diffs)
      --no-diff          Skip writing diff images
      --json             Print the full report as JSON

Examples
  unframer https://your-site.framer.website/ --out dist
  unframer https://your-site.framer.website/ --base-url https://example.com
  unframer page.html --single --out dist
  unframer verify https://your-site.framer.website/ --export dist
`;

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function printPageReport(report: ExtractReport): void {
  const totalRemoved = report.removals.reduce((a, r) => a + r.count, 0);
  console.log('');
  console.log('  Export complete');
  console.log('  ' + '─'.repeat(48));
  if (report.framerBuild) console.log(`  Framer build      ${report.framerBuild}`);
  console.log(`  Size              ${fmtBytes(report.bytesBefore)} → ${fmtBytes(report.bytesAfter)}`);
  console.log(`  Breakpoints       ${report.breakpoints.length}`);
  console.log(`  Animations        ${report.appearIds} id(s) → ${report.appearRulesEmitted} CSS rule(s)`);
  console.log(`  Elements freed    ${report.animatedElements}`);
  console.log(`  Scroll reveals    ${report.scrollReveals} element(s) → ${report.revealGroups} rule(s)`);
  console.log(`  Tickers           ${report.tickers}`);
  if (report.shimBytes > 0) console.log(`  Shim              ${report.shimBytes} B`);
  if (report.runtimeModules > 0) console.log(`  Runtime modules   ${report.runtimeModules} (full fidelity)`);
  console.log(`  Assets referenced ${report.assets.length}`);
  console.log(`  Artifacts removed ${totalRemoved}`);

  if (report.removals.length) {
    console.log('');
    console.log('  Removed');
    for (const r of report.removals) {
      console.log(`    ${String(r.count).padStart(3)}  ${r.detail}`);
    }
  }
  printWarnings(report.warnings);
}

function printSiteReport(report: SiteReport): void {
  console.log('');
  console.log('  Export complete');
  console.log('  ' + '─'.repeat(52));
  console.log(`  Pages             ${report.pagesExported} exported, ${report.pagesFailed} failed`);
  console.log(`  HTML              ${fmtBytes(report.totalBytesBefore)} → ${fmtBytes(report.totalBytesAfter)}`);
  console.log(`  Animation rules   ${report.totalAnimationRules}`);
  console.log(`  Assets            ${report.assetMode}`);
  if (report.assetMode === 'offline') {
    console.log(
      `                    ${report.assetsDownloaded}/${report.uniqueAssets} downloaded (${fmtBytes(report.assetBytes)})${
        report.assetsFailed > 0 ? `, ${report.assetsFailed} failed` : ''
      }`,
    );
  } else {
    console.log(`                    ${report.uniqueAssets} referenced`);
  }
  console.log(`  Artifacts removed ${report.totalArtifactsRemoved}`);
  if (report.formsFound > 0) console.log(`  Forms needing an endpoint  ${report.formsFound}`);

  console.log('');
  console.log('  Pages');
  for (const p of report.pages) {
    const mark = p.ok ? '✓' : '✗';
    const detail = p.ok ? p.filePath : `${p.filePath}  — ${p.error}`;
    console.log(`    ${mark}  ${p.route.padEnd(28)} ${detail}`);
  }

  printWarnings(report.warnings);
}

function printWarnings(warnings: readonly string[]): void {
  if (!warnings.length) return;
  console.log('');
  console.log('  Warnings');
  for (const w of warnings) console.log(`    !  ${w}`);
}

async function runSingle(args: Args): Promise<void> {
  const input = args.input!;
  let html: string;
  let baseUrl: string | undefined;

  if (/^https?:\/\//i.test(input)) {
    baseUrl = input;
    console.log(`  Fetching ${input} …`);
    html = await fetchPage(input);
  } else {
    const path = resolve(input);
    if (!existsSync(path)) {
      console.error(`  Input file not found: ${path}`);
      process.exit(1);
    }
    html = await readFile(path, 'utf8');
  }

  let result;
  try {
    result = extract(html, {
      assetMode: args.assetMode,
      compileAnimations: args.compileAnimations,
      keepRuntime: args.keepRuntime,
      baseUrl,
    });
  } catch (err) {
    if (err instanceof NotAFramerSiteError) {
      console.error(`  ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  const outDir = resolve(args.out);
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'index.html'), result.html, 'utf8');
  await writeFile(
    join(outDir, 'unframer-report.json'),
    JSON.stringify(result.report, null, 2),
    'utf8',
  );

  if (args.json) console.log(JSON.stringify(result.report, null, 2));
  else {
    printPageReport(result.report);
    console.log('');
    console.log(`  Written to ${join(outDir, 'index.html')}`);
    console.log('');
  }
}

async function runSite(args: Args): Promise<void> {
  const url = args.input!;
  console.log(`  Discovering routes from ${url} …`);

  const report = await exportSite(url, {
    outDir: args.out,
    assetMode: args.assetMode,
    compileAnimations: args.compileAnimations,
    keepRuntime: args.keepRuntime,
    baseUrl: args.baseUrl,
    maxPages: args.maxPages,
    maxDepth: args.maxDepth,
    concurrency: args.concurrency,
    sitemapOnly: args.sitemapOnly,
    onProgress: (done, total, route, ok) => {
      if (!args.json) {
        console.log(`  [${String(done).padStart(2)}/${total}] ${ok ? '✓' : '✗'} ${route}`);
      }
    },
    onAssetProgress: (done, total, _url, ok) => {
      // One line per 25 assets keeps a 400-asset site from flooding the terminal.
      if (args.json) return;
      if (!ok || done === total || done % 25 === 0) {
        console.log(`  assets [${done}/${total}]${ok ? '' : ' — failed, keeping CDN URL'}`);
      }
    },
  });

  let packaged: { configs: string[]; zipPath: string; zipBytes: number } | undefined;
  if (args.pkg && report.pagesExported > 0) {
    const { packageExport } = await import('./package.js');
    const zipTarget = `${resolve(args.out)}.zip`;
    const { configs, zip } = await packageExport(resolve(args.out), zipTarget);
    packaged = { configs, zipPath: zip.path, zipBytes: zip.bytes };
  }

  if (args.json) console.log(JSON.stringify({ ...report, packaged }, null, 2));
  else {
    printSiteReport(report);
    console.log('');
    console.log(`  Written to ${resolve(args.out)}`);
    if (packaged) {
      console.log(`  Host configs  ${packaged.configs.join(', ')}`);
      console.log(`  ZIP           ${packaged.zipPath} (${fmtBytes(packaged.zipBytes)})`);
    }
    console.log('');
  }

  if (report.pagesExported === 0) process.exit(3);
}

/** Derive routes from the export itself by finding every index.html. */
async function routesFromExport(dir: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  const routes: string[] = [];

  async function walk(current: string, prefix: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name === 'assets') continue;
        await walk(join(current, entry.name), `${prefix}/${entry.name}`);
      } else if (entry.name === 'index.html') {
        routes.push(prefix === '' ? '/' : prefix);
      }
    }
  }

  await walk(resolve(dir), '');
  return routes.sort((a, b) => (a === '/' ? -1 : b === '/' ? 1 : a.localeCompare(b)));
}

async function runVerify(argv: string[]): Promise<void> {
  const { verifyExport, DEFAULT_VIEWPORTS } = await import('./verify-runner.js');
  const { validateHtmlFiles } = await import('./validate-html.js');

  let originalUrl: string | undefined;
  let exportDir = 'out';
  let routes: string[] | undefined;
  let viewports = DEFAULT_VIEWPORTS;
  let diffDir: string | undefined = 'verify-diffs';
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--export' || a === '-e') exportDir = argv[++i] ?? 'out';
    else if (a === '--routes') routes = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (a === '--viewports') {
      viewports = (argv[++i] ?? '').split(',').map(Number).filter((n) => n > 0);
    } else if (a === '--diff-dir') diffDir = argv[++i];
    else if (a === '--no-diff') diffDir = undefined;
    else if (a === '--json') json = true;
    else if (!a.startsWith('-')) originalUrl = a;
  }

  if (!originalUrl) {
    console.error('  Usage: unframer verify <original-url> --export <dir>');
    process.exit(1);
  }

  const resolvedRoutes = routes?.length ? routes : await routesFromExport(exportDir);
  console.log(`  Verifying ${resolvedRoutes.length} route(s) against ${originalUrl}`);

  const report = await verifyExport({
    originalUrl,
    exportDir,
    routes: resolvedRoutes,
    viewports,
    diffDir,
    onProgress: (m) => { if (!json) console.log(m); },
  });

  // HTML validation, measured against the original rather than in absolute
  // terms: Framer's own markup carries issues we neither caused nor can fix,
  // and failing on those would be noise. Only what the export *introduced*
  // counts.
  const { readFile } = await import('node:fs/promises');
  const { validateAgainstBaseline } = await import('./validate-html.js');

  const introduced: Awaited<ReturnType<typeof validateAgainstBaseline>>['introduced'] = [];
  let preExistingCount = 0;

  for (const route of resolvedRoutes) {
    const file = join(resolve(exportDir), route === '/' ? 'index.html' : `${route.slice(1)}/index.html`);
    try {
      const exportedHtml = await readFile(file, 'utf8');
      const res = await fetch(new URL(route, originalUrl).toString(), {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      const originalHtml = await res.text();
      const result = await validateAgainstBaseline(exportedHtml, originalHtml, route);
      introduced.push(...result.introduced);
      preExistingCount += result.preExisting.length;
    } catch {
      // A page we cannot re-fetch simply is not baselined.
    }
  }

  const validation = {
    structuralErrors: introduced,
    advisory: [] as typeof introduced,
    preExisting: preExistingCount,
    pass: introduced.length === 0,
  };

  if (json) {
    console.log(JSON.stringify({ ...report, validation }, null, 2));
  } else {
    console.log('');
    console.log(report.pass && validation.pass ? '  VERIFICATION PASSED' : '  VERIFICATION FAILED');
    console.log('  ' + '─'.repeat(52));
    console.log(`  Routes            ${report.summary.routesPassed}/${report.summary.routesChecked} passed`);
    console.log(`  Text retention    ${(report.summary.worstTextRetention * 100).toFixed(1)}% (worst)`);
    console.log(`  Pixel difference  ${(report.summary.worstPixelDiff * 100).toFixed(2)}% (worst)`);
    console.log('                    badge removal and parallax are expected contributors');
    console.log(`  HTML structure    ${validation.structuralErrors.length} introduced, ${validation.preExisting} pre-existing in source`);

    for (const route of report.routes) {
      console.log('');
      console.log(`  ${route.pass ? '✓' : '✗'} ${route.route}`);
      if (route.error) console.log(`      ${route.error}`);
      for (const v of route.viewports) {
        console.log(
          `      ${v.pass ? '✓' : '✗'} ${String(v.viewport).padStart(4)}px  ` +
            `text ${(v.textRetention * 100).toFixed(1)}%  ` +
            `pixels ${(v.pixelDiffRatio * 100).toFixed(2)}%  ` +
            `${v.exported.visibleTextChars}/${v.original.visibleTextChars} chars`,
        );
        for (const f of v.failures) console.log(`           ! ${f}`);
      }
    }

    if (validation.structuralErrors.length > 0) {
      console.log('');
      console.log('  HTML structural errors');
      for (const e of validation.structuralErrors.slice(0, 10)) {
        console.log(`      ${e.rule} at ${e.line}:${e.column} — ${e.message}`);
      }
    }
    console.log('');
  }

  if (!report.pass || !validation.pass) process.exit(4);
}

async function runServe(argv: string[]): Promise<void> {
  const { startServer } = await import('./server.js');

  let port = 3000;
  let concurrency = 1;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' || argv[i] === '-p') port = Number(argv[++i]) || 3000;
    else if (argv[i] === '--concurrency') concurrency = Number(argv[++i]) || 1;
  }

  const server = await startServer({ port, concurrency });
  console.log('');
  console.log(`  Unframer server running at ${server.url}`);
  console.log('  Press Ctrl+C to stop.');
  console.log('');

  const shutdown = () => {
    console.log('\n  Shutting down…');
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * `exportsite` - one command for the highest-fidelity copy of a site.
 *
 * Keeps Framer's runtime so animations, 3D, scroll effects and every component
 * behave exactly as published; downloads all assets; writes host configs, a
 * local preview server and a ZIP.
 *
 * The preview server matters more than it looks: browsers block ES modules over
 * file://, so an exported folder that is merely unzipped and double-clicked
 * renders with no JavaScript at all and looks completely static.
 */
async function runExportSite(argv: string[]): Promise<void> {
  const url = argv.find((a) => /^https?:\/\//i.test(a));
  if (!url) {
    console.error('  Usage: unframer exportsite https://your-site.framer.website/');
    process.exit(1);
  }

  let outDir = 'site';
  let baseUrl: string | undefined;
  let maxPages = 50;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' || argv[i] === '-o') outDir = argv[++i] ?? 'site';
    else if (argv[i] === '--base-url') baseUrl = argv[++i];
    else if (argv[i] === '--max-pages') maxPages = Number(argv[++i]) || 50;
  }

  const { writePreviewServer } = await import('./preview.js');
  const { packageExport } = await import('./package.js');

  console.log('');
  console.log(`  Exporting ${url}`);
  console.log('  Full fidelity: runtime, animations, components and all assets.');
  console.log('');

  const report = await exportSite(url, {
    outDir,
    assetMode: 'offline',
    keepRuntime: true,
    compileAnimations: false,
    baseUrl,
    maxPages,
    onProgress: (done, total, route, ok) =>
      console.log(`  [${String(done).padStart(2)}/${total}] ${ok ? '✓' : '✗'} ${route}`),
    onAssetProgress: (done, total, _u, ok) => {
      if (!ok || done === total || done % 25 === 0) console.log(`  assets [${done}/${total}]`);
    },
  });

  if (report.pagesExported === 0) {
    console.error('  Nothing could be exported. Is this a published Framer site?');
    process.exit(3);
  }

  const preview = await writePreviewServer(outDir, url);
  const { zip } = await packageExport(outDir, `${resolve(outDir)}.zip`);

  console.log('');
  console.log('  Export complete');
  console.log('  ' + '─'.repeat(52));
  console.log(`  Pages             ${report.pagesExported}`);
  console.log(`  Assets            ${report.assetsDownloaded}/${report.uniqueAssets} (${fmtBytes(report.assetBytes)})`);
  console.log(`  Artifacts removed ${report.totalArtifactsRemoved}`);
  console.log(`  Preview server    ${preview.written.join(', ')}`);
  console.log(`  ZIP               ${zip.path} (${fmtBytes(zip.bytes)})`);
  console.log('');
  console.log('  TO VIEW IT, with animations working:');
  console.log(`      cd ${resolve(outDir)}`);
  console.log('      node serve.js          (or double-click start.bat)');
  console.log('');
  console.log('  Opening index.html directly will look static - browsers block');
  console.log('  JavaScript modules loaded from a file path.');
  console.log('');
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  if (rawArgs[0] === 'verify') {
    await runVerify(rawArgs.slice(1));
    return;
  }

  if (rawArgs[0] === 'serve') {
    await runServe(rawArgs.slice(1));
    return;
  }

  if (rawArgs[0] === 'exportsite') {
    await runExportSite(rawArgs.slice(1));
    return;
  }

  const args = parseArgs(rawArgs);

  if (args.help || !args.input) {
    console.log(HELP);
    process.exit(args.input ? 0 : 1);
  }

  const isUrl = /^https?:\/\//i.test(args.input);

  try {
    if (isUrl && !args.single) await runSite(args);
    else await runSingle(args);
  } catch (err) {
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
