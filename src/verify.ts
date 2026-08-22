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

/**
 * Content-parity probe, run on BOTH the original site and the export.
 *
 * This is the check that catches content going missing, and it is deliberately
 * not `innerText`: `innerText` happily returns text sitting inside an
 * `opacity:0` element, so a page can report full text while showing none of it.
 * That is exactly how an export shipped with half its content invisible while
 * every assertion passed.
 *
 * "Visible" here means the element and its whole ancestor chain are rendered —
 * not `display:none`, not `visibility:hidden`, and not effectively transparent.
 * Comparing the export's visible text against the original's is the only
 * assertion that fails when content silently disappears.
 */
export const CONTENT_PROBE_SCRIPT = `(function () {
  function visible(el) {
    for (var node = el; node && node !== document.documentElement; node = node.parentElement) {
      var cs = getComputedStyle(node);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      if (parseFloat(cs.opacity) < 0.05) return false;
    }
    return true;
  }

  // Collect text from leaf-ish elements so nested nodes are not counted twice.
  var words = [];
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
  var node;
  while ((node = walker.nextNode())) {
    var text = (node.nodeValue || '').replace(/\\s+/g, ' ').trim();
    if (!text) continue;
    var parent = node.parentElement;
    if (!parent) continue;
    if (parent.closest('script,style,noscript,template')) continue;
    if (!visible(parent)) continue;
    words.push(text);
  }

  var joined = words.join(' ');

  var imgs = Array.prototype.slice.call(document.querySelectorAll('img'));
  return {
    visibleText: joined,
    visibleTextChars: joined.length,
    visibleTextWords: joined ? joined.split(/\\s+/).length : 0,
    headings: Array.prototype.slice.call(document.querySelectorAll('h1,h2,h3'))
      .filter(visible).map(function (h) { return (h.textContent || '').trim(); }).filter(Boolean),
    links: document.querySelectorAll('a[href]').length,
    images: imgs.length,
    imagesBroken: imgs.filter(function (i) { return i.complete && i.naturalWidth === 0; }).length,
    documentHeight: document.body.scrollHeight
  };
})()`;

/**
 * Scroll a page end to end so lazy images load and scroll-triggered reveals
 * fire, then return to the top and settle deterministically.
 *
 * Both the original and the export need this, or the comparison measures
 * "whatever happened to be above the fold" on each.
 *
 * The final step drives every pending animation and transition to completion
 * rather than sleeping. Reveal transitions run for 0.7s while an earlier
 * version of this waited 150ms, so the probe measured elements mid-fade and
 * reported the export as having lost 80% of its text — a pure timing artifact.
 * Waiting longer would only have made the flake rarer; finishing the animations
 * removes it. Infinite effects (the ticker) are skipped, since finish() throws
 * on them and they never gate visibility.
 */
export const SETTLE_SCRIPT = `(async function () {
  var step = Math.max(200, Math.floor(window.innerHeight * 0.8));
  for (var y = 0; y < document.body.scrollHeight; y += step) {
    window.scrollTo(0, y);
    await new Promise(function (r) { setTimeout(r, 60); });
  }
  window.scrollTo(0, 0);

  // Let any observer callbacks queued by that scroll actually run.
  await new Promise(function (r) { requestAnimationFrame(function () { setTimeout(r, 120); }); });

  document.getAnimations().forEach(function (a) {
    try {
      var t = a.effect && a.effect.getTiming ? a.effect.getTiming() : null;
      if (t && t.iterations === Infinity) return;
      a.finish();
    } catch (e) { /* non-finishable effect */ }
  });

  await new Promise(function (r) { requestAnimationFrame(function () { r(null); }); });
  return document.body.scrollHeight;
})()`;

export interface ContentProbe {
  visibleText: string;
  visibleTextChars: number;
  visibleTextWords: number;
  headings: string[];
  links: number;
  images: number;
  imagesBroken: number;
  documentHeight: number;
}

/** Format one viewport's result for terminal output. */
export function formatVerifyResult(r: VerifyResult): string {
  const mark = r.pass ? 'PASS' : 'FAIL';
  const head = `  ${mark}  ${r.viewportWidth}px — ${r.renderedElements} element(s) rendered, ${r.visibleTextChars} char(s) visible`;
  if (r.pass) return head;
  return [head, ...r.failures.map((f) => `        ${f}`)].join('\n');
}
