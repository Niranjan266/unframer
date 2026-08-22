/**
 * Runtime content rescue.
 *
 * Many sites hide content at `opacity: 0` and reveal it with JavaScript on
 * load or scroll. When that JavaScript depends on something the export cannot
 * reproduce — a hydration step, an analytics callback, a bundle that no longer
 * initialises — the reveal never fires and the text stays invisible forever.
 * Measured on one real site: 223 elements stuck hidden, including the whole
 * navigation, while layout and images were pixel-correct.
 *
 * The Framer path solves this statically, because Framer writes the hidden
 * state inline where it can be lifted into CSS at export time. An arbitrary
 * site does not: the state is often applied at runtime by the site's own
 * script, so there is nothing in the HTML to rewrite. The rescue therefore has
 * to run in the page.
 *
 * The governing rule is **do nothing when the site works**. A grace period lets
 * the site's own animations run first; only what is still invisible afterwards
 * is touched. If every reveal fires normally, this finds nothing and the page
 * is untouched.
 *
 * Equally important is what it must never reveal. Plenty of things are hidden
 * on purpose — modals, tooltips, dropdown panels, carousel slides that are not
 * current, screen-reader-only text, scroll triggers with no content. Revealing
 * those would be a worse defect than the one being fixed, so the checks below
 * are deliberately conservative: when in doubt, leave it alone.
 */

/** Class marking an element the rescue revealed, for styling and debugging. */
export const RESCUE_CLASS = 'uf-rescued';

/** Attribute set on <html> once the pass has run, so it cannot run twice. */
export const RESCUE_FLAG = 'data-uf-rescued';

/**
 * How long to wait before deciding a reveal is not coming.
 *
 * Long enough for entry animations, staggered sequences and lazy hydration to
 * finish; short enough that a visitor does not sit looking at a blank section.
 */
const GRACE_MS = 2500;

export const RESCUE_SCRIPT = `(function () {
  var GRACE = ${GRACE_MS};
  var CLASS = '${RESCUE_CLASS}';
  var FLAG = '${RESCUE_FLAG}';

  // Hidden on purpose: revealing any of these is worse than the bug.
  var SKIP_SELECTOR = [
    '[aria-hidden="true"]',
    '[hidden]',
    'dialog', '[role="dialog"]', '[role="alertdialog"]', '[role="tooltip"]',
    '[role="menu"]', '[role="listbox"]', '[popover]',
    '.modal', '.tooltip', '.dropdown-menu', '.popover', '.offcanvas',
    '.sr-only', '.visually-hidden', '.screen-reader-text',
    '.swiper-slide', '.slick-slide', '.carousel-item',
    'nav[aria-expanded="false"]'
  ].join(',');

  function contentful(el) {
    // Only rescue things a visitor would actually miss.
    if (el.matches('img, svg, picture, video, canvas')) return true;
    var text = (el.textContent || '').trim();
    if (text.length >= 2) return true;
    return false;
  }

  function deliberatelyHidden(el) {
    for (var p = el; p && p !== document.documentElement; p = p.parentElement) {
      if (p.matches && p.matches(SKIP_SELECTOR)) return true;
      var cs = getComputedStyle(p);
      // A transparent, click-through layer is a trigger or an overlay.
      if (cs.pointerEvents === 'none' && !contentful(p)) return true;
    }
    return false;
  }

  function stillHidden(el) {
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false; // not our business
    if (parseFloat(cs.opacity) >= 0.05) return false;

    // Zero-area elements are spacers and triggers, not content.
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;

    // Something is actively animating it — the site is working, leave it be.
    if (typeof el.getAnimations === 'function' && el.getAnimations().length > 0) return false;

    return true;
  }

  function run() {
    if (document.documentElement.hasAttribute(FLAG)) return;
    document.documentElement.setAttribute(FLAG, '');

    var all = document.body ? document.body.querySelectorAll('*') : [];
    var stuck = [];

    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') continue;
      if (!contentful(el)) continue;
      if (deliberatelyHidden(el)) continue;
      if (!stillHidden(el)) continue;
      stuck.push(el);
    }

    if (!stuck.length) return;

    // Only the outermost hidden element needs revealing; children inherit the
    // change and revealing each one separately causes visible double-fades.
    var outermost = stuck.filter(function (el) {
      for (var p = el.parentElement; p; p = p.parentElement) {
        if (stuck.indexOf(p) !== -1) return false;
      }
      return true;
    });

    var reveal = function (el) {
      el.classList.add(CLASS);
      el.style.setProperty('opacity', '1', 'important');
      // A transform left at its pre-animation offset would leave the element
      // visible but displaced, so clear it only when one is actually set.
      var t = getComputedStyle(el).transform;
      if (t && t !== 'none') el.style.setProperty('transform', 'none', 'important');
    };

    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (typeof IntersectionObserver === 'undefined' || reduced) {
      outermost.forEach(reveal);
      return;
    }

    // Reveal on approach rather than all at once, so the page still reads as
    // designed rather than snapping every section into view together.
    var io = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) {
          reveal(entries[i].target);
          io.unobserve(entries[i].target);
        }
      }
    }, { rootMargin: '200px 0px', threshold: 0.01 });

    outermost.forEach(function (el) { io.observe(el); });

    // Anything the observer never fires for still has to appear.
    setTimeout(function () {
      outermost.forEach(function (el) {
        if (!el.classList.contains(CLASS)) reveal(el);
      });
    }, 8000);
  }

  function schedule() { setTimeout(run, GRACE); }

  if (document.readyState === 'complete') schedule();
  else window.addEventListener('load', schedule);
})();`;

/** Transition so a rescued element fades in rather than snapping. */
export const RESCUE_CSS =
  `.${RESCUE_CLASS}{transition:opacity .6s ease,transform .6s ease}` +
  `@media (prefers-reduced-motion:reduce){.${RESCUE_CLASS}{transition:none}}`;

/** Approximate size of the injected shim, for the export report. */
export function rescueBytes(): number {
  return Buffer.byteLength(RESCUE_SCRIPT + RESCUE_CSS, 'utf8');
}
