# Contributing

Thanks for helping out. This document covers how to run the project and — more usefully — the traps that have already cost real debugging time here, so you don't rediscover them.

## Setup

```bash
npm install
npm run check          # typecheck + tests
```

```bash
npx tsx src/cli.ts test/fixtures/synthetic/framer-like.html --single --out out
npx tsx src/cli.ts https://some-site.framer.website/ --out dist --offline
npx tsx src/cli.ts serve --port 3000
```

Browser-based verification additionally needs Chromium:

```bash
npx playwright install chromium
npx tsx src/cli.ts verify https://some-site.framer.website/ --export dist
```

## How the code is laid out

| Area | Files |
|---|---|
| Extraction | `extract.ts` (orchestrator), `detect.ts`, `strip.ts` |
| Animation | `appear.ts`, `easing.ts`, `breakpoints.ts` |
| Interactions | `reveal.ts`, `ticker.ts`, `shim.ts` |
| Multi-page | `site.ts`, `routes.ts`, `links.ts` |
| Assets | `assets.ts`, `download.ts`, `localize.ts` |
| Verification | `verify.ts`, `verify-runner.ts`, `validate-html.ts`, `serve.ts` |
| Product | `server.ts`, `ui.ts`, `queue.ts`, `package.ts`, `ssrf.ts` |

`extract.ts` is where ordering matters most — read the comment at the top before changing it.

## Testing

```bash
npm test
```

Most integration tests run against captured copies of real Framer sites. Those are **third-party content and gitignored**, so on a fresh clone they skip. `test/fixtures/synthetic/framer-like.html` is hand-authored to the same shape, ships with the repo, and exercises the whole pipeline — that is what CI runs against, and it is where a new assertion belongs unless you specifically need a real page.

To work with real pages locally:

```bash
curl -sL -A "Mozilla/5.0" https://some-site.framer.website/ -o test/fixtures/some-site.html
```

Do not commit them.

## Traps

Each of these produced a confidently wrong result during development. They are commented in the code; this is the short version.

**Nothing may be left hidden.** Framer server-renders many elements with an inline `opacity:0` that only its runtime reveals. Strip the runtime without handling them and the page renders mostly blank. Only a *subset* carry `data-framer-appear-id` — one real page has 325 hidden elements and zero appear ids. Any new invisibility check must walk **every** element, never just animated ones.

**Animations are breakpoint-scoped.** An appear id can carry per-breakpoint variants keyed by hash, and `default` covers whatever breakpoints have no explicit variant. Collapsing to `default` leaves elements invisible everywhere it forgot.

**A non-compositing tab never advances the document timeline.** Animations report `playState: "running"` with `currentTime: 0` forever, so any assertion that waits on wall-clock time reports a false failure. Drive them with `Animation.finish()`.

**Order matters when verifying reveals.** Adding the reveal class *starts* a transition. A transition started after `finish()` freezes at its from-value and reports every revealed element as still hidden. Reveal first, then finish.

**`finish()` throws on infinite effects.** The ticker marquee is infinite. Guard it or the whole check crashes.

**Partial opacity is design, not breakage.** Framer uses `opacity: 0.6` for dimmed decoration and fully transparent zero-size elements as scroll triggers — one is literally named `Trigger`. Flag `opacity < 0.05` *and contains text*, or you will report design intent as a defect.

**Compare against the source, not an ideal.** Framer's own markup carries validation warnings we neither caused nor can fix. Only failures the export *introduced* should fail a build.

## Adding support for another platform

The pipeline is Framer-specific by design — `detect.ts` refuses anything it cannot positively identify, because running the strip list on unknown markup mangles it rather than failing cleanly. Supporting Webflow or Wix means a parallel detector and strip list, not loosening this one.

## Style

- TypeScript, strict. `npm run typecheck` must pass.
- Comments explain *why*, especially where behaviour looks odd — most of the odd-looking code here is load-bearing.
- New behaviour needs a test. New *fixes* need a test that fails without them.
- No new runtime dependency without a reason; the shim shipped to users must stay dependency-free.

## Scope and conduct

This tool is for exporting sites you own or are authorised to export. Please keep issues and pull requests focused on that use.
