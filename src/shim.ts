/**
 * The runtime shim.
 *
 * Everything Framer's 212 KB React bundle did that we still need, in a few
 * hundred bytes of dependency-free JavaScript. Currently that is scroll-triggered
 * reveals; tickers and entry animations are pure CSS and need no script at all.
 *
 * Split into two parts on purpose:
 *
 *   - A synchronous head script that does nothing but set `.uf-js` on the root
 *     element. It must be inline and in `<head>` so the hidden state applies
 *     before first paint. Deferring it produces a flash of fully-visible content
 *     that then vanishes and fades back in.
 *
 *   - A deferred body script holding the observer, which has no reason to block
 *     rendering.
 *
 * The `.uf-js` gate is the safety property that matters: every hidden rule is
 * scoped under it, so if scripting is disabled or either script fails to parse,
 * the class is never set and the page renders fully visible. The failure mode is
 * "no animation", never "invisible page" — which is the bug this whole subsystem
 * exists to prevent.
 */

import { REVEAL_ATTR, REVEAL_VISIBLE_CLASS } from './reveal.js';

/**
 * Synchronous, inline, first thing in <head>.
 * Kept to a single statement so there is nothing to go wrong before paint.
 */
export const HEAD_SHIM = `document.documentElement.classList.add('uf-js');`;

/**
 * Deferred reveal observer.
 *
 * Elements already in view when the page loads intersect immediately, so
 * above-the-fold content reveals without waiting for a scroll. `rootMargin`
 * trims the bottom edge slightly so a reveal starts just before the element is
 * fully on screen rather than exactly at it.
 */
export const BODY_SHIM = `(function () {
  var SEL = '[${REVEAL_ATTR}]';
  var VISIBLE = '${REVEAL_VISIBLE_CLASS}';
  var nodes = document.querySelectorAll(SEL);
  if (!nodes.length) return;

  function revealAll() {
    for (var i = 0; i < nodes.length; i++) nodes[i].classList.add(VISIBLE);
  }

  // Without IntersectionObserver, or with motion reduced, show everything at
  // once rather than risk leaving content hidden.
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (typeof IntersectionObserver === 'undefined' || reduced) { revealAll(); return; }

  var io = new IntersectionObserver(function (entries) {
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].isIntersecting) {
        entries[i].target.classList.add(VISIBLE);
        io.unobserve(entries[i].target);
      }
    }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.01 });

  for (var i = 0; i < nodes.length; i++) io.observe(nodes[i]);

  // Failsafe: anything still hidden after the page settles is revealed. Covers
  // elements the observer can never fire for, such as those inside a subtree
  // that is display:none at load and shown later.
  window.addEventListener('load', function () {
    setTimeout(function () {
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        if (el.classList.contains(VISIBLE)) continue;
        if (el.offsetParent === null) continue;
        var r = el.getBoundingClientRect();
        if (r.top < window.innerHeight && r.bottom > 0) el.classList.add(VISIBLE);
      }
    }, 1200);
  });
})();`;

/** Approximate gzipped size, for the export report. */
export function shimBytes(): number {
  return Buffer.byteLength(HEAD_SHIM + BODY_SHIM, 'utf8');
}
