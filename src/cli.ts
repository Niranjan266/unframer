#!/usr/bin/env node
/**
 * Unframer CLI.
 *
 * Usage:
 *   unframer <url|file> [--out DIR] [--offline] [--no-animations] [--json]
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { extract, NotAFramerSiteError } from './extract.js';
import { fetchPage } from './fetch.js';
import type { AssetMode, ExtractReport } from './types.js';

interface Args {
  input?: string;
  out: string;
  assetMode: AssetMode;
  compileAnimations: boolean;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    out: 'out',
    assetMode: 'hotlink',
    compileAnimations: true,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--out' || a === '-o') args.out = argv[++i] ?? 'out';
    else if (a === '--offline') args.assetMode = 'offline';
    else if (a === '--no-animations') args.compileAnimations = false;
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
  -o, --out <dir>     Output directory (default: out)
      --offline       Download assets locally (phase 03 — not yet implemented)
      --no-animations Skip animation compilation; force final visible state
      --json          Print the report as JSON
  -h, --help          Show this help

Examples
  unframer https://example.framer.website/
  unframer page.html --out dist
`;

/** Human-readable byte size. */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function printReport(report: ExtractReport): void {
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

  if (report.warnings.length) {
    console.log('');
    console.log('  Warnings');
    for (const w of report.warnings) console.log(`    !  ${w}`);
  }
  console.log('');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.input) {
    console.log(HELP);
    process.exit(args.input ? 0 : 1);
  }

  const input = args.input;
  let html: string;
  let baseUrl: string | undefined;

  try {
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
  } catch (err) {
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
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

  if (args.json) {
    console.log(JSON.stringify(result.report, null, 2));
  } else {
    printReport(result.report);
    console.log(`  Written to ${join(outDir, 'index.html')}`);
    console.log('');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
