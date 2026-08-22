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
      --json             Print the report as JSON
  -h, --help             Show this help

Examples
  unframer https://your-site.framer.website/ --out dist
  unframer https://your-site.framer.website/ --base-url https://example.com
  unframer page.html --single --out dist
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

  if (args.json) console.log(JSON.stringify(report, null, 2));
  else {
    printSiteReport(report);
    console.log('');
    console.log(`  Written to ${resolve(args.out)}`);
    console.log('');
  }

  if (report.pagesExported === 0) process.exit(3);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

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
