/**
 * Scroll-reveal reconstruction.
 *
 * Phase 01 handled elements carrying `data-framer-appear-id`, whose animations
 * ship as a declarative JSON island. But that is only a subset. Framer also
 * server-renders a much larger set of elements with an inline `opacity:0` that
 * its React runtime reveals — scroll-triggered reveals, nav items, component
 * containers — and those have no declarative data at all.
 *
 * Measured on real pages: framer.university has 325 such elements and zero
 * appear-ids. Stripping the runtime without handling them leaves more than half
 * the page permanently invisible, including the entire navigation. This module
 * exists because that bug shipped once already.
 *
 * The reconstruction: lift each element's inline hidden state into a deduplicated
 * CSS rule, then reveal it with an IntersectionObserver. The inline style tells us
 * the "from" state for free — opacity, transform and filter — so the motion stays
 * close to the original without any declarative animation data.
 *
 * Progressive enhancement is deliberate and load-bearing. The hidden state applies
 * only under `.uf-js`, a class set synchronously by a tiny inline script. If
 * scripting is off or the shim fails to run, the class is never added and every
 * element renders visible. Failure mode is "no animation", never "invisible page".
 */

import type { CheerioAPI } from 'cheerio';
import { APPEAR_ATTR } from './appear.js';

/** Attribute marking an element the shim should reveal. */
export const REVEAL_ATTR = 'data-uf-reveal';

/** Class the shim adds once an element enters the viewport. */
export const REVEAL_VISIBLE_CLASS = 'uf-in';

/** Properties that together constitute a Framer "hidden" state. */
const HIDDEN_PROPS = ['opacity', 'transform', 'filter', 'will-change'] as const;

/** Below this, we treat the element as deliberately hidden rather than faded. */
const HIDDEN_OPACITY_THRESHOLD = 0.5;

interface FromState {
  opacity: string;
  transform?: string;
  filter?: string;
}

export interface RevealResult {
  css: string;
  /** Number of elements annotated for reveal. */
  elements: number;
  /** Number of distinct from-states, i.e. emitted CSS rules. */
  groups: number;
}

/** Parse a style attribute into an ordered map of declarations. */
function parseStyle(style: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const decl of style.split(';')) {
    const trimmed = decl.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(':');
    if (colon < 0) continue;
    out.set(trimmed.slice(0, colon).trim().toLowerCase(), trimmed.slice(colon + 1).trim());
  }
  return out;
}

function serializeStyle(decls: Map<string, string>): string {
  return [...decls].map(([k, v]) => `${k}:${v}`).join(';');
}

/** Stable signature so elements sharing a from-state share one CSS rule. */
function signatureOf(state: FromState): string {
  return `${state.opacity}|${state.transform ?? ''}|${state.filter ?? ''}`;
}

/**
 * Find every element hidden by an inline style, lift that state into CSS, and
 * annotate it for the shim.
 *
 * Elements with `data-framer-appear-id` are skipped — the appear compiler owns
 * those, and driving one element from both systems would fight over `animation`
 * and `transition`.
 */
export function extractScrollReveals($: CheerioAPI): RevealResult {
  const groups = new Map<string, { id: string; state: FromState }>();
  let elements = 0;

  $('[style]').each((_, el) => {
    const $el = $(el);
    if ($el.attr(APPEAR_ATTR) !== undefined) return;

    const style = $el.attr('style');
    if (!style || !style.includes('opacity')) return;

    const decls = parseStyle(style);
    const rawOpacity = decls.get('opacity');
    if (rawOpacity === undefined) return;

    const opacity = Number.parseFloat(rawOpacity);
    if (!Number.isFinite(opacity) || opacity >= HIDDEN_OPACITY_THRESHOLD) return;

    const state: FromState = {
      opacity: rawOpacity,
      transform: decls.get('transform'),
      filter: decls.get('filter'),
    };

    // A transform of "none" carries no motion; drop it so more elements share a group.
    if (state.transform === 'none') state.transform = undefined;
    if (state.filter === 'none') state.filter = undefined;

    const signature = signatureOf(state);
    let group = groups.get(signature);
    if (!group) {
      group = { id: `r${groups.size}`, state };
      groups.set(signature, group);
    }

    // Remove the inline hidden state — CSS now owns it, gated behind .uf-js.
    for (const prop of HIDDEN_PROPS) decls.delete(prop);
    if (decls.size === 0) $el.removeAttr('style');
    else $el.attr('style', serializeStyle(decls));

    $el.attr(REVEAL_ATTR, group.id);
    elements++;
  });

  return { css: buildRevealCss([...groups.values()]), elements, groups: groups.size };
}

/**
 * Build the reveal stylesheet.
 *
 * Every hidden rule is scoped under `.uf-js` so that without the shim the page
 * renders fully visible.
 */
function buildRevealCss(groups: Array<{ id: string; state: FromState }>): string {
  if (groups.length === 0) return '';

  const rules: string[] = [
    // Transition applies whether or not JS ran; harmless when nothing changes.
    `[${REVEAL_ATTR}]{transition:opacity .7s cubic-bezier(.44,0,.16,1),transform .7s cubic-bezier(.44,0,.16,1),filter .7s cubic-bezier(.44,0,.16,1)}`,
  ];

  for (const { id, state } of groups) {
    const decls = [`opacity:${state.opacity}`];
    if (state.transform) decls.push(`transform:${state.transform}`);
    if (state.filter) decls.push(`filter:${state.filter}`);
    rules.push(
      `.uf-js [${REVEAL_ATTR}="${id}"]:not(.${REVEAL_VISIBLE_CLASS}){${decls.join(';')}}`,
    );
  }

  // Revealed state, and the reduced-motion escape hatch.
  rules.push(
    `[${REVEAL_ATTR}].${REVEAL_VISIBLE_CLASS}{opacity:1;transform:none;filter:none}`,
    `@media (prefers-reduced-motion:reduce){.uf-js [${REVEAL_ATTR}]{opacity:1!important;transform:none!important;filter:none!important;transition:none!important}}`,
  );

  return rules.join('\n');
}
