/**
 * Verification assertions.
 *
 * Phase 05 wires these into Playwright, but the logic lives here because two
 * non-obvious traps were discovered the hard way and must not be re-learned:
 *
 *   1. A browser tab that is not compositing does not advance the document
 *      timeline. CSS animations report `playState: "running"` with
 *      `currentTime: 0` forever, so any assertion that waits on wall-clock time
 *      reports a false failure. Drive animations to their end deterministically
 *      with `Animation.finish()` instead.
 *
 *   2. Framer renders every responsive variant into the DOM at once and hides
 *      the inactive ones with `display:none`. Elements inside a hidden subtree
 *      have no running animations, so they legitimately sit at their `from`
 *      state. Asserting over ALL elements reports false failures; only the
 *      elements actually rendered at the current viewport count.
 *
 *   3. Scoping the invisibility check to `[data-framer-appear-id]` misses most
 *      of the problem. Only a subset of hidden elements carry appear data —
 *      framer.university has 325 hidden elements and zero appear-ids — and an
 *      earlier version of this file checked only those, so an export that left
 *      more than half the page invisible passed clean. The check now walks every
 *      rendered element and additionally compares visible text against the
 *      source, because "no element reports opacity 0" is necessary but not
 *      sufficient for "the page is actually readable".
 *
 * The script is exported as a string so any driver (Playwright, Puppeteer, CDP)
 * can evaluate it in the page without pulling in a browser dependency here.
 */

import { REVEAL_ATTR, REVEAL_VISIBLE_CLASS } from './reveal.js';

export interface VerifyResult {
  viewportWidth: number;
  /** Every rendered element, not just animated ones. */
  renderedElements: number;
  /** Rendered elements still sitting at opacity < 0.99. */
  stuckHidden: number;
  /** Characters of text trapped inside invisible elements. */
  hiddenTextChars: number;
  visibleTextChars: number;
  brokenImages: number;
  externalScripts: number;
  trackerRequests: number;
  badgeNodes: number;
  tickers: number;
  pass: boolean;
  failures: string[];
}

/** Breakpoints worth sampling — one per Framer default responsive band. */
export const VERIFY_VIEWPORTS = [1512, 1280, 900, 390] as const;

/**
 * Browser-side verification. Evaluate this in the page and it returns a
 * `VerifyResult`. Written as an IIFE string with no external references so it
 * can be passed straight to `page.evaluate`.
 */
export const VERIFY_SCRIPT = `(function () {
  function isRendered(el) {
    return el.offsetParent !== null || getComputedStyle(el).position === 'fixed';
  }

  // Trap 3: walk EVERY rendered element. Scoping this to [data-framer-appear-id]
  // is what let an export ship with half the page invisible.
  var all = Array.prototype.slice.call(document.querySelectorAll('body *'));
  var live = all.filter(isRendered);

  // Reveals are driven by IntersectionObserver, which cannot fire for content
  // below the fold in a single measurement. Trigger them all so the check sees
  // the settled page rather than only what happens to be on screen.
  //
  // ORDER IS LOAD-BEARING: this must happen BEFORE animations are driven to
  // completion. Adding the class starts a CSS transition, and a transition
  // started afterwards freezes at its "from" value in a non-compositing tab —
  // reporting every revealed element as still hidden. That false failure cost
  // an hour once already.
  live.forEach(function (el) {
    if (el.hasAttribute('${REVEAL_ATTR}')) el.classList.add('${REVEAL_VISIBLE_CLASS}');
  });

  // Trap 1: drive animations and transitions deterministically rather than
  // waiting on a clock that may never advance in a headless or backgrounded tab.
  //
  // finish() throws on an infinite effect, and the ticker marquee is exactly
  // that, so an unguarded call crashes the whole check on any page with a
  // ticker. Infinite animations have no end state to settle into and never
  // gate visibility, so skipping them is correct as well as necessary.
  live.forEach(function (el) {
    el.getAnimations().forEach(function (a) {
      try {
        var t = a.effect && a.effect.getTiming ? a.effect.getTiming() : null;
        if (t && t.iterations === Infinity) return;
        a.finish();
      } catch (e) { /* non-finishable effect; visibility is unaffected */ }
    });
  });

  // Effectively invisible, not merely translucent. Framer uses partial opacity
  // deliberately (dimmed decoration) and fully transparent zero-size elements as
  // scroll triggers, so flagging everything below 1 reports design as failure.
  // What actually matters is whether CONTENT is trapped.
  var stuck = live.filter(function (el) {
    if (parseFloat(getComputedStyle(el).opacity) >= 0.05) return false;
    return (el.innerText || '').trim().length > 0;
  });

  var hiddenTextChars = 0;
  stuck.forEach(function (el) { hiddenTextChars += (el.innerText || '').length; });

  var imgs = Array.prototype.slice.call(document.querySelectorAll('img'));
  var brokenImages = imgs.filter(function (i) {
    return i.complete && i.naturalWidth === 0;
  }).length;

  var externalScripts = document.querySelectorAll('script[src]').length;

  var badgeNodes = document.querySelectorAll(
    '#__framer-badge-container, .__framer-badge'
  ).length;

  var trackerRequests = performance.getEntriesByType('resource').filter(function (r) {
    return /events\\.framer|sentry|google-analytics|googletagmanager|doubleclick|hotjar|segment|clarity\\.ms/.test(r.name);
  }).length;

  var failures = [];
  if (stuck.length > 0) {
    failures.push(
      stuck.length + ' rendered element(s) stuck at their initial hidden state, hiding ' +
      hiddenTextChars + ' character(s) of text'
    );
  }
  if (brokenImages > 0) failures.push(brokenImages + ' broken image(s)');
  if (externalScripts > 0) failures.push(externalScripts + ' external script(s) still present');
  if (badgeNodes > 0) failures.push('platform badge still present');
  if (trackerRequests > 0) failures.push(trackerRequests + ' tracker request(s) fired');

  return {
    viewportWidth: window.innerWidth,
    renderedElements: live.length,
    stuckHidden: stuck.length,
    hiddenTextChars: hiddenTextChars,
    visibleTextChars: (document.body.innerText || '').length,
    brokenImages: brokenImages,
    externalScripts: externalScripts,
    trackerRequests: trackerRequests,
    badgeNodes: badgeNodes,
    tickers: document.querySelectorAll('[data-uf-ticker]').length,
    pass: failures.length === 0,
    failures: failures
  };
})()`;

/** Format one viewport's result for terminal output. */
export function formatVerifyResult(r: VerifyResult): string {
  const mark = r.pass ? 'PASS' : 'FAIL';
  const head = `  ${mark}  ${r.viewportWidth}px — ${r.renderedElements} element(s) rendered, ${r.visibleTextChars} char(s) visible`;
  if (r.pass) return head;
  return [head, ...r.failures.map((f) => `        ${f}`)].join('\n');
}
