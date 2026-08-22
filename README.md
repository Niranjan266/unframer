# Unframer

Converts a published Framer site into portable, framework-free HTML/CSS that runs on any static host.

**Status: Phase 06 complete** — whole-site export, self-contained with `--offline`, interactions reconstructed, verified against the live original, and served through a web UI and API.

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
      --offline          Download every asset for a fully portable package
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

## Offline assets

`--offline` downloads every image, font and media file once across the whole site and rewrites all references:

```
assets/images/   assets/fonts/   assets/media/   assets/files/
```

Verified on a live two-page site: **37/37 assets downloaded, zero off-host requests in the browser.**

Four details carry most of the risk here:

- **`srcset` is rewritten in full.** Framer ships several `?scale-down-to=` variants per image. Rewriting only `src` leaves the browser fetching the rest from the CDN, quietly defeating the whole point.
- **Local names hash the full URL, query included.** Those variants share a basename, so hashing the pathname alone would collapse them into one file and silently lose resolutions.
- **Paths are relative to the page, not the site root** — `../../assets/…` from `/blog/post` — for the same portability reason as links.
- **Social preview images are the exception.** `og:image` and `twitter:image` are resolved by crawlers from outside the page and *must* be absolute, so they are only localised when `--base-url` is set. Without it they keep their CDN URL and you get a warning, because a working preview beats a relative path no crawler can resolve.

Anything that fails to download keeps its original URL and is reported. A hotlinked asset still renders; a rewritten-but-missing one does not.

## Interactions

Entry animations ship as declarative JSON, but **most hidden elements do not**. Framer server-renders a much larger set with an inline `opacity:0` that only its React runtime reveals — and only a subset of those carry an appear id.

> **This shipped as a bug once.** `framer.university` has 325 such elements and *zero* appear ids. The export left 155 of them permanently invisible, hiding 4,557 characters — more text than the 3,943 that were visible, including the entire navigation. The test suite passed clean because every invisibility assertion was scoped to `[data-framer-appear-id]`.

Two reconstructions now run, in this order:

**Tickers first.** `li.ticker-item` is a stable Framer class. The track is duplicated so it can translate by exactly half its own width and land where it started — offset by `-50% - gap/2`, since the two halves are separated by one extra gap. Getting that wrong produces a visible stutter every cycle. Speed and direction are *not* encoded in the page, so both are defaults and the report says so.

**Scroll reveals second** — the ticker track is hidden inline too, so if the reveal pass claimed it first the ticker would end up visible but motionless. Each element's inline hidden state is lifted into a deduplicated CSS rule (310 elements → 5 rules on framer.university) and revealed with an `IntersectionObserver`.

### The safety property

Every hidden rule is scoped under `.uf-js`, a class set by a synchronous inline head script. If scripting is off or the shim fails to parse, the class is never added and **the page renders fully visible**. The failure mode is "no animation", never "invisible page".

Verified with the class removed: 154 rendered reveal elements, zero hidden, zero trapped text.

The shim is ~1.6 KB, dependency-free. Entry animations and tickers need no JavaScript at all.

### Not reconstructed

Hover variants, accordions, carousels and scroll-linked parallax remain in the compiled bundle with no reliable DOM signature — `data-framer-component-type` only ever contains `RichTextContainer` and `SVG`, so there is nothing honest to key off. They are left static rather than guessed at.

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

Five traps make naive verification report false results — three false failures, one false pass, one crash. All are encoded in `src/verify.ts`:

1. **A non-compositing tab never advances the document timeline.** Animations report `playState: "running"` with `currentTime: 0` indefinitely. Never assert on wall-clock waits — drive them with `Animation.finish()`.
2. **Only rendered elements count.** Framer emits every responsive variant into the DOM and hides the inactive ones with `display:none`. Those legitimately sit at their initial state.
3. **Reveal *before* finishing animations.** Adding `.uf-in` starts a CSS transition, and a transition started *after* `finish()` freezes at its "from" value in a non-compositing tab — reporting every revealed element as still hidden. Order is load-bearing.
4. **`finish()` throws on infinite effects.** The ticker marquee is infinite, so an unguarded call crashes the whole check on any page with a ticker.
5. **Scoping to `[data-framer-appear-id]` gives a false pass** — the bug described above. Walk every rendered element, and measure *trapped text*, because "no element reports opacity 0" is necessary but not sufficient for "the page is readable".

The threshold matters too: elements below `opacity: 0.05` **containing text** are failures. Framer legitimately uses partial opacity for dimmed decoration and fully transparent zero-size elements as scroll triggers (one is literally named `Trigger`), so flagging everything under 1 reports design intent as breakage.

Verified at 1512 / 900 / 390 px against `framer.university` (the 887 KB page that exposed the bug) and `novo` (3 tickers): zero elements stuck with text, zero trapped characters, zero broken images, zero external scripts, zero badge nodes, zero tracker requests — and all three tickers animating with track widths far exceeding their containers.

### The automated harness

```bash
npx tsx src/cli.ts verify https://your-site.framer.website/ --export dist
```

Loads the original and the export side by side in real Chromium, at every viewport, and compares them:

```
VERIFICATION PASSED
Routes            2/2 passed
Text retention    100.0% (worst)
Pixel difference  11.71% (worst)
HTML structure    0 introduced, 4 pre-existing in source
```

Three independent signals, because no single one suffices:

- **Content parity** — visible text in the export against the original. This is the assertion that catches content disappearing, and it compares *visible* text, since `innerText` returns text inside `opacity:0` elements.
- **Visual diff** — pixel comparison at each viewport, with diff images written to `verify-diffs/`.
- **Self-checks** — no trackers, no badge, no external scripts, nothing stuck hidden.

Both pages are scrolled end to end and settled deterministically before measuring. The original hides content until scrolled too, so measuring either one cold proves nothing.

**Pixel difference is a gross-damage tripwire, not a fidelity claim.** A correct export differs from the original by construction: the "Made in Framer" badge is deliberately gone, and unreconstructed parallax settles elsewhere. Inspecting a real diff showed those two causes account for most of an 11.7% difference at 1512px. Tightening the threshold would fail every correct export; quietly raising it until things pass would make it meaningless. So the *hard* gates sit on the unambiguous signals, and the pixel number is reported with its diff image for a human to judge.

**HTML validation is measured against the source, not in the absolute.** Framer emits a `<style>` inside a `<div>`, present identically in the original. Only issues the export *introduced* fail the run — currently zero.

Three more traps were found while building the harness itself, each of which produced a confidently wrong result:

- `reducedMotion: 'reduce'`, set for screenshot stability, changes what the **original** renders — Framer's runtime leaves an element at `opacity:0` under it, hiding 422 characters — so the export was being compared against a degraded baseline and appeared to have *more* content than the original.
- Settling for 150 ms against a 700 ms transition measured elements mid-fade and reported an 80% content loss that did not exist. Sleeping longer only makes that rarer; finishing the animations removes it.
- `finish()` throws on infinite effects, so the ticker crashed the check.

## Web UI and API

```bash
npx tsx src/cli.ts serve --port 3000
```

Paste a URL, watch progress stream in, download a deployable ZIP.

| Route | |
|---|---|
| `POST /api/jobs` | Queue an export; returns a job |
| `GET /api/jobs/:id` | Job state |
| `GET /api/jobs/:id/events` | Progress as server-sent events |
| `GET /api/jobs/:id/download` | The packaged ZIP |

Node's own `http` module and a single inline HTML document — no framework, no build step, and no external requests. It would be a poor look for a tool whose purpose is removing third-party dependencies from a page to then load a CDN framework of its own.

The queue is in-process rather than BullMQ on Redis: an export is one bounded task measured in seconds, and requiring Redis before you can convert a site is the wrong trade. Concurrency is capped, because each job already runs its own bounded fetch pool and overlapping them multiplies out into the CDN throttling phase 03 exists to avoid.

### SSRF protection

The server fetches a URL supplied by whoever is using it. Unguarded, that is a request forwarder into the host's private network — point it at `http://169.254.169.254/` and it reads cloud instance credentials.

`assertPublicUrl` **resolves** the hostname and rejects private, loopback, link-local and reserved ranges. Resolution is the part that matters: checking the literal hostname would miss a public DNS name deliberately pointed at `127.0.0.1`.

Verified against loopback, private ranges, cloud metadata, IPv6 loopback and non-HTTP schemes — all six rejected with a clear reason.

## Packaging

`--package` writes host configuration and a ZIP:

```
netlify.toml   vercel.json   _headers
```

The cache headers are not boilerplate. Asset filenames carry a hash of their source URL, so an asset cannot change content without changing name — which makes `immutable` genuinely correct for `assets/`. HTML has no such guarantee and must revalidate, or a deploy strands visitors on a stale page pointing at assets that no longer exist.

### Not built

**Payments.** There is no Stripe integration — wiring real payment processing needs live credentials and an account, and a half-built billing path is worse than none. The queue and job model leave a clean seam for an entitlement check before `enqueue`.

## Tests

```bash
npm test
```

199 tests: unit coverage of the compiler, easing, breakpoint, route, link, asset-localisation, interaction, serving, validation, queue, packaging and SSRF logic, plus golden-file assertions against four real captured Framer pages.

The most important of those asserts that **no element is left hidden by an inline style** — checked across every element, not just animated ones. That is the regression that shipped once.

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 01 | Single-page export, strip pipeline, animation compiler | **done** |
| 02 | Multi-page: sitemap/crawl discovery, link rewriting | **done** |
| 03 | Offline assets: throttled downloader, `srcset` variants, fonts | **done** |
| 04 | Interaction shim: scroll reveals, tickers | **done** |
| 05 | Verification harness: Playwright, visual diff, HTML validation | **done** |
| 06 | Product surface: queue, web UI, API, packaging | **done** |

Only entry animations are declarative. Scroll reveals, hover variants, tickers and accordions live inside the compiled React bundle and must be reconstructed from DOM signatures — that is phase 04, and the highest-risk part of the project.

`--offline` is accepted but not yet implemented; it warns and falls back to hotlinking rather than silently producing a broken package.

## Scope

Intended for exporting sites you own or are authorised to export. Framer's badge and hosting terms are contractual, so any hosted version of this should verify domain ownership (DNS `TXT` or a meta token) before a paid export.
