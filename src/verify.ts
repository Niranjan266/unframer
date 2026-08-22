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
 * The script is exported as a string so any driver (Playwright, Puppeteer, CDP)
 * can evaluate it in the page without pulling in a browser dependency here.
 */

export interface VerifyResult {
  viewportWidth: number;
  totalAppearElements: number;
  renderedElements: number;
  stuckHidden: number;
  stuckIds: string[];
  brokenImages: number;
  externalScripts: number;
  trackerRequests: number;
  badgeNodes: number;
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

  var all = Array.prototype.slice.call(document.querySelectorAll('[data-framer-appear-id]'));
  var live = all.filter(isRendered);

  // Trap 1: drive animations deterministically rather than waiting on a clock
  // that may never advance in a headless or backgrounded tab.
  live.forEach(function (el) {
    el.getAnimations().forEach(function (a) { a.finish(); });
  });

  var stuck = live.filter(function (el) {
    return parseFloat(getComputedStyle(el).opacity) < 0.99;
  });

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
    failures.push(stuck.length + ' rendered element(s) stuck at their initial hidden state');
  }
  if (brokenImages > 0) failures.push(brokenImages + ' broken image(s)');
  if (externalScripts > 0) failures.push(externalScripts + ' external script(s) still present');
  if (badgeNodes > 0) failures.push('platform badge still present');
  if (trackerRequests > 0) failures.push(trackerRequests + ' tracker request(s) fired');

  return {
    viewportWidth: window.innerWidth,
    totalAppearElements: all.length,
    renderedElements: live.length,
    stuckHidden: stuck.length,
    stuckIds: stuck.map(function (el) { return el.getAttribute('data-framer-appear-id'); }),
    brokenImages: brokenImages,
    externalScripts: externalScripts,
    trackerRequests: trackerRequests,
    badgeNodes: badgeNodes,
    pass: failures.length === 0,
    failures: failures
  };
})()`;

/** Format one viewport's result for terminal output. */
export function formatVerifyResult(r: VerifyResult): string {
  const mark = r.pass ? 'PASS' : 'FAIL';
  const head = `  ${mark}  ${r.viewportWidth}px — ${r.renderedElements}/${r.totalAppearElements} element(s) rendered`;
  if (r.pass) return head;
  return [head, ...r.failures.map((f) => `        ${f}`)].join('\n');
}
