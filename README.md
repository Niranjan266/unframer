# Unframer

Converts a published Framer site into portable, framework-free HTML/CSS that runs on any static host.

**Status: Phase 02 complete** — whole-site export with CDN-hotlinked assets.

```bash
npm install
npx tsx src/cli.ts https://your-site.framer.website/ --out dist
npx tsx src/cli.ts https://your-site.framer.website/ --base-url https://example.com
npx tsx src/cli.ts page.html --single --out dist    # one page, from a local file
```

Passing a URL exports the **whole site** by default.

```
Options
  -o, --out <dir>        Output directory (default: out)
      --base-url <url>   Final public URL; rewrites canonical/og:url and sitemap
      --single           Export only the given page
      --sitemap-only     Discover routes from sitemap.xml only, skip crawling
      --max-pages <n>    Page cap for discovery (default: 100)
      --max-depth <n>    Crawl depth (default: 3)
      --concurrency <n>  Parallel fetches (default: 4 — the CDN throttles)
      --offline          Download assets locally (phase 03 — not yet implemented)
      --no-animations    Skip animation compilation; force final visible state
      --json             Print the report as JSON
```

## What it does

| | |
|---|---|
| **Strips trackers** | Framer analytics (`events.framer.com`) plus ~20 third-party analytics hosts, inline tracker bootstraps, and tracking pixels |
| **Strips the runtime** | The React + Motion bundle and its module preloads — 212 KB on a typical page |
| **Removes the watermark** | The badge container and its CSS |
| **Preserves animations** | Entry animations are compiled to pure CSS keyframes, no JavaScript |
| **Keeps the design intact** | Component CSS, fonts, breakpoints and SVG defs are left untouched |
| **Exports every page** | Sitemap + bounded crawl, relative link rewriting, generated `sitemap.xml` and `robots.txt` |

Output is the server-rendered HTML Framer already produces — semantic and framework-free — with the platform layer removed.

## How it works

Framer server-renders the page, then hydrates it with React. The served HTML is already complete, which is what makes static export viable. The pipeline reads the declarative data *before* stripping it, compiles it to CSS, then removes the runtime.

```
discover routes
  └─ per page: detect → read appear spec + breakpoints → compile CSS
                 → neutralise inline state → strip → rewrite links → write
site: sitemap.xml + robots.txt + aggregate report
```

Sequencing is load-bearing. See `src/extract.ts` and `src/site.ts`.

## Multi-page output

Routes map to directory style, so URLs stay clean on any static host without server configuration:

| Route | File |
|---|---|
| `/` | `index.html` |
| `/about` | `about/index.html` |
| `/blog/post` | `blog/post/index.html` |

Internal links are rewritten **relative and file-explicit** — `../../about/index.html`, not `/about` or `../../about/`. That is the only form that works in all three places the export might live: opened straight off the filesystem, served from a static host, and served from a subdirectory. Bare directory links rely on the server resolving an index document, which `file://` does not do.

Routes come from crawled pages, so they are untrusted input: `routeToFilePath` rejects traversal, backslashes and drive letters rather than letting a link write outside the output directory.

Links to pages *outside* the export are made absolute back to the original site and reported, rather than left root-relative to 404 on the new host.

Pass `--base-url` to have `canonical` and `og:url` retargeted at your domain. Without it they are removed — left pointing at Framer, they would tell search engines your self-hosted copy is a duplicate.

## The trap this project exists to avoid

Framer writes each animated element's initial state inline:

```html
<div data-framer-appear-id="16xq61f" style="opacity:0.001; transform:translateY(-20px)">
```

…and the animation that undoes it lives in a JSON island driven by the runtime. **Strip the runtime without compiling that JSON and every animated element stays permanently invisible.** The page renders mostly blank with no obvious cause.

So `compileAppearCss` and `neutralizeInlineInitialState` must always run together. Only `opacity`, `transform` and `will-change` are stripped from the inline style — the same attribute often carries real layout properties.

### Animations are breakpoint-scoped

An appear id may carry per-breakpoint variants keyed by hash (`mz2m8j`, `19t9inl`, …), matching the `.hidden-*` classes in the breakpoint stylesheet. Framer only emits a hashed variant where that breakpoint *differs* from the base, so **`default` covers whatever breakpoints are left over**.

Collapsing everything to `default` is the bug that leaves elements invisible on every breakpoint it forgot. `breakpointsForDefault()` exists precisely for this, and it is covered by tests.

### Springs become `linear()`, not `ease-out`

Framer drives entry animations with Motion springs (`duration` + `bounce`). Rather than flattening those to a lossy keyword, `src/easing.ts` solves the spring analytically and emits a sampled CSS `linear()` curve — faithful motion with zero JavaScript.

## Verifying an export

Two traps make naive verification report false failures. Both are encoded in `src/verify.ts`:

1. **A non-compositing tab never advances the document timeline.** Animations report `playState: "running"` with `currentTime: 0` indefinitely. Never assert on wall-clock waits — drive them with `Animation.finish()`.
2. **Only rendered elements count.** Framer emits every responsive variant into the DOM and hides the inactive ones with `display:none`. Those legitimately sit at their initial state; asserting over all of them reports false failures.

Verified manually at 1512 / 1280 / 900 / 390 px against `framer-template`: zero stuck elements, zero broken images, zero external scripts, zero badge nodes, zero tracker requests.

## Tests

```bash
npm test
```

105 tests: unit coverage of the compiler, easing, breakpoint, route and link logic, plus golden-file assertions against four real captured Framer pages.

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 01 | Single-page export, strip pipeline, animation compiler | **done** |
| 02 | Multi-page: sitemap/crawl discovery, link rewriting | **done** |
| 03 | Offline assets: throttled downloader, `srcset` variants, fonts | next |
| 04 | Interaction shim: scroll reveals, hover, tickers, accordions | |
| 05 | Verification harness: Playwright, visual diff, W3C, Lighthouse | |
| 06 | Product surface: queue, UI, packaging | |

Only entry animations are declarative. Scroll reveals, hover variants, tickers and accordions live inside the compiled React bundle and must be reconstructed from DOM signatures — that is phase 04, and the highest-risk part of the project.

`--offline` is accepted but not yet implemented; it warns and falls back to hotlinking rather than silently producing a broken package.

## Scope

Intended for exporting sites you own or are authorised to export. Framer's badge and hosting terms are contractual, so any hosted version of this should verify domain ownership (DNS `TXT` or a meta token) before a paid export.
